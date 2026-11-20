/**
 * The board's own conversation.
 *
 * It is an ordinary DSH session created the way "new conversation" creates one,
 * pinned to a workspace so it shows up in the sidebar and survives a restart.
 * We only remember its id; the Host owns the agent, the transcript, and the
 * model selection.
 *
 * This is deliberately the same shape as 工作树's session: one long-lived
 * conversation beside the panel, with a prompt section that tells the model
 * what it is looking at. Anything smarter (event batches, focus) belongs to the
 * caller, not here.
 *
 * @module dsh-excalidraw/chat
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { writeFileAtomic } from './atomic.js'

/** Workspace title used when the chat cwd has none yet. */
const WORKSPACE_TITLE = '画板'

/**
 * @param {{
 *   ctx: object,
 *   file: string,
 *   cwd?: string,
 *   logger?: object,
 *   now?: () => number,
 * }} options
 */
export function createChatSession(options) {
  const { ctx, file, logger } = options
  const now = options.now ?? Date.now

  const hostRoot = () => ctx?.root ?? ctx
  const host = (name) => {
    try {
      return hostRoot()?.get?.(name) ?? undefined
    } catch {
      return undefined
    }
  }

  let sessionId = null
  let loaded = false
  let inflight = null

  function cwd() {
    const wanted = typeof options.cwd === 'string' ? options.cwd.trim() : ''
    return wanted === '' ? homedir() : wanted
  }

  async function loadId() {
    if (loaded) return sessionId
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (typeof parsed?.sessionId === 'string' && parsed.sessionId !== '') sessionId = parsed.sessionId
    } catch {
      /* no file yet, or unreadable: start fresh */
    }
    return sessionId
  }

  async function saveId(id) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, `${JSON.stringify({ sessionId: id, updatedAt: now() }, null, 2)}\n`)
  }

  function liveAgent(id) {
    try {
      return host('agents')?.get?.(id) ?? undefined
    } catch {
      return undefined
    }
  }

  /** The live agent, resuming a persisted session when it is not loaded. */
  async function resolveAgent(id) {
    const live = liveAgent(id)
    if (live) return live
    try {
      const resolved = await host('sessionController')?.resolveAgent?.(id)
      return resolved?.agent ?? undefined
    } catch (error) {
      logger?.debug?.(`dsh-excalidraw: 恢复画板会话失败：${error?.message ?? error}`)
      return undefined
    }
  }

  async function create() {
    const controller = host('sessionController')
    if (typeof controller?.create !== 'function') {
      const error = new Error('宿主没有提供会话服务，无法创建画板会话')
      error.code = 'session-unavailable'
      throw error
    }
    const dir = cwd()
    let created
    try {
      const registry = host('workspaceRegistry')
      if (registry !== undefined) {
        const workspace = (await registry.resolveByPath?.(dir)) ?? (await registry.create?.(dir, WORKSPACE_TITLE))
        if (workspace?.id !== undefined) created = await controller.create({ workspaceId: workspace.id })
      }
    } catch (error) {
      logger?.warn?.(`dsh-excalidraw: 按工作区创建会话失败，改用目录：${error?.message ?? error}`)
      created = undefined
    }
    if (created?.sessionId === undefined) {
      created = await controller.create({ cwd: dir })
    }
    if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
      const error = new Error('宿主没有返回会话编号')
      error.code = 'session-unavailable'
      throw error
    }
    return created.sessionId
  }

  /** The session id, reusing the remembered one while it still resolves. */
  function ensure() {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const known = await loadId()
      if (known !== null && (await resolveAgent(known)) !== undefined) return known
      if (host('sessionController') === undefined && known === null) {
        const error = new Error('宿主没有提供会话服务')
        error.code = 'session-unavailable'
        throw error
      }
      const created = await create()
      sessionId = created
      await saveId(created)
      return created
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** Forget the id; the old conversation stays in the sidebar as what it was. */
  async function reset() {
    await loadId()
    sessionId = null
    await saveId(null).catch((error) => logger?.warn?.(`dsh-excalidraw: 写 chat.json 失败：${error?.message ?? error}`))
    return ensure()
  }

  /** The session this plugin owns, for prompt sections. */
  function owns(agent) {
    return sessionId !== null && agent?.id === sessionId
  }

  return {
    ensure,
    reset,
    cwd,
    owns,
    id: () => sessionId,
    load: loadId,
    /** The live agent of the board conversation, when it is loaded. */
    agent: () => (sessionId === null ? undefined : liveAgent(sessionId)),
    /** A stable id for a notice this plugin injects. */
    noticeId: () => randomUUID(),
  }
}
