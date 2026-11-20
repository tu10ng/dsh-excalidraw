/**
 * The board's HTTP surface: state, save, transaction commit, cancellation, the
 * event stream, and the panel's own assets.
 *
 * Two invariants:
 *
 * - **Every handler is fenced.** The Host's connection fence answers first; a
 *   Host without one accepts loopback only. The browser page shares the Host's
 *   origin, so it carries the credentials the fence looks for.
 * - **Every error is a code.** A refusal is `{ ok: false, reason, error }` with a
 *   status the panel can act on — `stale-revision` is a re-read, `busy` is a
 *   retry, `invalid-request` is a bug.
 *
 * @module dsh-excalidraw/routes
 */

import { ROUTE_BASE, ROUTES } from './shared/protocol.js'
import { readAsset, resolveAsset } from './assets.js'

const MAX_BODY_BYTES = 24 * 1024 * 1024
const PING_MS = 25_000

/**
 * @param {{
 *   store: object,
 *   journal: object,
 *   presence: object,
 *   chat: object,
 *   assetsRoot: string,
 *   config: { board: string },
 *   logger?: object,
 *   rootCtx?: object,
 *   connection?: object,
 * }} deps
 */
export function createRoutes(deps) {
  const { store, journal, presence, chat, assetsRoot, config, logger } = deps

  const fence = () => {
    if (deps.connection !== undefined) return deps.connection
    try {
      return deps.rootCtx?.get?.('connection') ?? undefined
    } catch {
      return undefined
    }
  }

  function refuse(request, response) {
    let rejection
    let fenceFailed = false
    const connection = fence()
    try {
      rejection = connection?.requestRejection?.(request)
    } catch (error) {
      logger?.warn?.(`dsh-excalidraw: 连接围栏异常：${error?.message ?? error}`)
      rejection = 403
      fenceFailed = true
    }
    const fenced = rejection !== undefined && rejection !== null && rejection !== false
    const localScript = !fenceFailed && isLoopback(request) && !hasBrowserCredentials(request)
    if (fenced && !localScript) {
      sendJson(response, typeof rejection === 'number' ? rejection : 403, {
        ok: false,
        reason: 'forbidden',
        error: '请求被宿主连接围栏拒绝',
      })
      return true
    }
    if (!fenced && (connection === undefined || connection === null) && !isLoopback(request)) {
      sendJson(response, 403, { ok: false, reason: 'forbidden', error: '只接受本机请求' })
      return true
    }
    return false
  }

  /** Wrap one handler with the fence, readiness, and the code→status mapping. */
  function route(handler) {
    return async (request, response) => {
      if (refuse(request, response)) return
      try {
        await store.ready()
        const result = await handler(request, response)
        if (result !== undefined && !response.writableEnded) sendJson(response, 200, result)
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'internal'
        const status = statusOf(code)
        if (status >= 500) {
          logger?.warn?.(`dsh-excalidraw: ${request.method} ${request.url} 失败：${error?.stack ?? error?.message ?? error}`)
        }
        if (response.writableEnded) return
        sendJson(response, status, {
          ok: false,
          reason: code,
          error: error instanceof Error ? error.message : String(error),
          ...(Number.isInteger(error?.rev) ? { rev: error.rev } : {}),
          ...(Array.isArray(error?.ids) ? { ids: error.ids } : {}),
        })
      }
    }
  }

  function verbs(suffix, handlers) {
    return {
      kind: 'exact',
      path: `${ROUTE_BASE}${suffix}`,
      handler: async (request, response) => {
        const handler = handlers[request.method]
        if (handler === undefined) {
          response.setHeader('allow', Object.keys(handlers).join(', '))
          sendJson(response, 405, {
            ok: false,
            reason: 'method-not-allowed',
            error: `请用 ${Object.keys(handlers).join(' / ')}`,
          })
          return
        }
        await route(handler)(request, response)
      },
    }
  }

  const query = (request) => new URL(request.url ?? ROUTE_BASE, 'http://localhost').searchParams

  const state = verbs('/state', {
    GET: async (request) => {
      const wanted = Number(query(request).get('rev'))
      const head = store.head()
      if (Number.isInteger(wanted) && wanted === head.rev) {
        return { ok: true, ...head, cursor: journal.cursor, unchanged: true }
      }
      return {
        ok: true,
        ...store.snapshot(),
        cursor: journal.cursor,
        events: journal.recent(80),
      }
    },
  })

  const save = verbs('/save', {
    POST: async (request) => {
      const body = await readJson(request)
      const result = await store.save({
        baseRev: body.baseRev,
        elements: body.elements,
        appState: body.appState,
        files: body.files,
      })
      return { ok: true, ...result }
    },
  })

  const tx = verbs('/tx', {
    POST: async (request) => {
      const body = await readJson(request)
      const result = await store.commit(body.txId, {
        baseRev: body.baseRev,
        elements: body.elements,
        appState: body.appState,
        files: body.files,
        deferred: body.deferred,
      })
      return { ok: true, ...result }
    },
  })

  const cancel = verbs('/cancel', {
    POST: async (request) => {
      const body = await readJson(request)
      if (typeof body.txId !== 'string' || body.txId === '') {
        return { ok: false, reason: 'invalid-request', error: '缺少 txId' }
      }
      const result = await store.abort(body.txId, 'cancelled')
      return { ok: true, ...result }
    },
  })

  // The board's own conversation: the panel asks for its id, and may replace it.
  const chatState = verbs('/chat', {
    GET: async () => {
      const sessionId = await chat.ensure()
      return { ok: true, sessionId, cwd: chat.cwd() }
    },
  })

  const chatReset = verbs('/chat/reset', {
    POST: async () => {
      const sessionId = await chat.reset()
      return { ok: true, sessionId }
    },
  })

  const stream = verbs('/stream', { GET: serveStream })

  function serveStream(request, response) {
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders?.()

    const send = (frame) => {
      if (response.writableEnded) return
      try {
        response.write(`data: ${JSON.stringify(frame)}\n\n`)
      } catch {
        // The socket died between the check and the write; 'close' cleans up.
      }
    }

    const head = store.head()
    send({
      frame: 'hello',
      board: config.board,
      rev: head.rev,
      leases: head.leases,
      cursor: journal.cursor,
      presence: presence.count,
    })

    const leave = presence.enter()
    const offStore = store.onChange((payload) => send(storeFrame(payload)))
    const offJournal = journal.subscribe((event) => send({ frame: 'event', event }))
    const ping = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n')
    }, PING_MS)
    ping.unref?.()

    request.on('close', () => {
      clearInterval(ping)
      offStore()
      offJournal()
      leave()
      if (!response.writableEnded) response.end()
    })
    // The handler owns the response for its whole lifetime.
    return new Promise(() => {})
  }

  const assets = {
    kind: 'prefix',
    path: ROUTES.assets,
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD')
        sendJson(response, 405, { ok: false, reason: 'method-not-allowed', error: '静态资源只支持 GET' })
        return
      }
      if (refuse(request, response)) return
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      const suffix = pathname.slice(ROUTES.assets.length)
      const file = resolveAsset(assetsRoot, suffix)
      const asset = file === null ? null : await readAsset(file)
      if (asset === null) {
        sendJson(response, 404, { ok: false, reason: 'not-found', error: '没有这个资源' })
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', asset.type)
      response.setHeader('cache-control', asset.cache)
      response.setHeader('x-content-type-options', 'nosniff')
      if (request.method === 'HEAD') response.end()
      else response.end(asset.body)
    },
  }

  return [state, save, tx, cancel, chatState, chatReset, stream, assets]
}

/** One store change → one SSE frame the panel already knows how to apply. */
function storeFrame(payload) {
  if (payload.kind === 'tx-open') {
    return {
      frame: 'tx',
      txId: payload.txId,
      rev: payload.rev,
      ops: payload.ops,
      ids: payload.ids,
      created: payload.created ?? [],
      leases: payload.leases,
    }
  }
  if (payload.kind === 'tx-settled') {
    return {
      frame: 'settled',
      txId: payload.txId,
      rev: payload.rev,
      status: payload.status,
      ids: payload.ids,
      deferred: payload.deferred ?? [],
      leases: payload.leases,
      elements: payload.elements ?? [],
    }
  }
  return {
    frame: 'scene',
    rev: payload.rev,
    elements: payload.elements ?? [],
    leases: payload.leases,
  }
}

function statusOf(code) {
  if (code === 'stale-revision' || code === 'busy') return 409
  if (code === 'unknown-transaction') return 404
  if (code === 'payload-too-large') return 413
  if (code === 'forbidden') return 403
  if (code === 'invalid-request') return 400
  return 500
}

function sendJson(response, status, body) {
  if (response.writableEnded) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`)
      error.code = 'payload-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('请求体必须是 JSON 对象')
      error.code = 'invalid-request'
      throw error
    }
    return parsed
  } catch (error) {
    if (error?.code === 'invalid-request') throw error
    const wrapped = new Error(`请求体不是合法 JSON：${error?.message ?? error}`)
    wrapped.code = 'invalid-request'
    throw wrapped
  }
}

function hasBrowserCredentials(request) {
  const cookie = request.headers?.cookie
  if (typeof cookie === 'string' && cookie.trim() !== '') return true
  const origin = request.headers?.origin
  return typeof origin === 'string' && origin.trim() !== ''
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  let hostname
  try {
    hostname = new URL(`http://${request.headers?.host ?? ''}`).hostname
  } catch {
    return false
  }
  if (!(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))) return false
  return request.headers?.['sec-fetch-site'] !== 'cross-site'
}
