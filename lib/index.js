/**
 * dsh-excalidraw — Host half.
 *
 * Composition, in the order it matters:
 *
 * 1. **The board** (`scene-store`) owns the file, the revision, and the leases.
 * 2. **The journal** receives every `session/event` as one rail row; it is the
 *    only place the session log and the drawing meet.
 * 3. **The tools** change the board through transactions, so an element the
 *    agent touches is locked while it is touched.
 * 4. **The HTTP surface** serves the panel, its vendor bundle, and one SSE
 *    stream that carries board frames and session events on the same wire.
 *
 * Nothing here imports another plugin. The board talks to DSH through documented
 * services (`tools`, `webServer`, `session/event`) and to the browser through
 * its own routes, which is what keeps the data independent.
 *
 * @module dsh-excalidraw
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createChatSession } from './chat.js'
import { createEventJournal } from './event-journal.js'
import { createPresence } from './presence.js'
import { registerBoardPrompt } from './prompt.js'
import { createRoutes } from './routes.js'
import { createSceneStore } from './scene-store.js'
import { normalizeSessionEvent } from './session-events.js'
import { isBoardId, LIMITS } from './shared/protocol.js'
import { createTools } from './tools.js'

/** Must equal `package.json`'s version; `scripts/check.mjs` enforces it. */
export const VERSION = '0.1.0'

/** Plugin id; also the Loader row id in `cordis.patch.yml`. */
export const name = 'dsh-excalidraw'

/** Applied when the patch row gives no `config`. */
export const DEFAULTS = Object.freeze({
  root: '',
  board: 'main',
  waitMs: 1500,
  leaseMs: 20_000,
  maxEvents: 400,
  chatCwd: '',
  guidance: true,
})

/** Cadence of lease expiry while the Host runs. */
const SWEEP_MS = 5_000

function resolveRoot(config, env, home) {
  const configured = typeof config.root === 'string' ? config.root.trim() : ''
  if (configured !== '') return configured
  return `${env?.DSH_HOME || `${home}/.dsh`}/excalidraw`
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx Cordis context
 * @param {object} [config] the patch row's `config`
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  const logger = ctx?.logger
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd()
  const env = { DSH_HOME: process.env.DSH_HOME }
  const root = resolveRoot(resolved, env, home)
  const board = isBoardId(resolved.board) ? resolved.board : DEFAULTS.board
  if (board !== resolved.board) logger?.warn?.(`dsh-excalidraw: 画板名 ${resolved.board} 不合法，改用 ${board}`)

  const settings = {
    board,
    waitMs: clampInt(resolved.waitMs, 200, 10_000, DEFAULTS.waitMs),
    leaseMs: clampInt(resolved.leaseMs, 2_000, 120_000, DEFAULTS.leaseMs),
    maxEvents: clampInt(resolved.maxEvents, 40, 2_000, DEFAULTS.maxEvents),
  }

  const store = createSceneStore({ root, board, logger })
  const journal = createEventJournal({ limit: settings.maxEvents })
  const presence = createPresence()
  const now = () => Date.now()
  const chat = createChatSession({
    ctx,
    file: path.join(root, board, 'chat.json'),
    cwd: typeof resolved.chatCwd === 'string' ? resolved.chatCwd : '',
    logger,
    now,
  })

  ctx.effect(() => {
    // Load eagerly so the first panel paint does not wait for two file reads.
    void store.ready().catch((error) => logger?.warn?.(`dsh-excalidraw: 画板加载失败：${error?.message ?? error}`))
    // Remember which conversation this board owns before anyone asks for prompt text.
    void chat.load().catch(() => undefined)
    const sweep = setInterval(() => {
      void store.sweep().catch(() => undefined)
    }, SWEEP_MS)
    sweep.unref?.()
    return () => {
      clearInterval(sweep)
      void store.close()
    }
  }, 'dsh-excalidraw: board')

  ctx.effect(() => {
    const dispose = ctx.on?.('session/event', (session, event) => {
      try {
        const record = normalizeSessionEvent(session?.id ?? 'unknown', event, { now: now() })
        if (record !== null) journal.push(record)
      } catch (error) {
        logger?.warn?.(`dsh-excalidraw: 会话事件归一化失败：${error?.message ?? error}`)
      }
    })
    return () => {
      try {
        dispose?.()
      } catch {
        /* unloading must not throw */
      }
    }
  }, 'dsh-excalidraw: session events')

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      try {
        const definitions = createTools({ store, journal, presence, config: settings, now })
        const disposers = definitions.map((definition) => toolCtx.tools.register(definition))
        toolCtx.logger?.info?.(`dsh-excalidraw: 注册了 ${definitions.length} 个 Agent 工具`)
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              /* one failed disposer must not keep the rest */
            }
          }
        }
      } catch (error) {
        toolCtx.logger?.warn?.(`dsh-excalidraw: 工具注册失败：${error?.message ?? error}`)
        return () => {}
      }
    }, 'dsh-excalidraw: agent tools')
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      try {
        const routes = createRoutes({
          store,
          journal,
          presence,
          chat,
          config: settings,
          assetsRoot: fileURLToPath(new URL('./', import.meta.url)),
          logger,
          rootCtx: ctx,
          connection: ctx.get?.('connection') ?? undefined,
        })
        const disposers = routes.map((definition) => webCtx.webServer.register(definition))
        webCtx.logger?.info?.(`dsh-excalidraw: 注册了 ${disposers.length} 条路由（/api/excalidraw）`)
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              /* unloading must not throw */
            }
          }
        }
      } catch (error) {
        webCtx.logger?.warn?.(`dsh-excalidraw: 路由注册失败：${error?.message ?? error}`)
        return () => {}
      }
    }, 'dsh-excalidraw: web routes')
  })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => {
      if (resolved.guidance === false) return () => {}
      try {
        return registerBoardPrompt(promptCtx.systemPrompt, chat)
      } catch (error) {
        promptCtx.logger?.warn?.(`dsh-excalidraw: 提示词注册失败：${error?.message ?? error}`)
        return () => {}
      }
    }, 'dsh-excalidraw: prompt')
  })

  logger?.info?.(`dsh-excalidraw v${VERSION} 已挂载（root=${root}，board=${board}，上限 ${LIMITS.elements} 元素）`)
}

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export default { name, apply }
