/**
 * The panel's only way to talk to the Host: four small JSON calls.
 *
 * A failure keeps its machine code, because the caller reacts to the code, not
 * to the sentence: `stale-revision` re-reads, `busy` retries, `forbidden`
 * stops.
 *
 * @module dsh-excalidraw/client/api
 */

const BASE = 'api/excalidraw'

export class BoardFailure extends Error {
  constructor(payload, status) {
    super(payload?.error ?? `HTTP ${status}`)
    this.name = 'BoardFailure'
    this.code = payload?.reason ?? 'transport'
    this.status = status
    if (Number.isInteger(payload?.rev)) this.rev = payload.rev
    if (Array.isArray(payload?.ids)) this.ids = payload.ids
  }
}

async function call(path, options = {}) {
  let response
  try {
    response = await fetch(`${BASE}/${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    })
  } catch (error) {
    throw new BoardFailure({ reason: 'transport', error: error?.message ?? String(error) }, 0)
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) throw new BoardFailure(payload, response.status)
  return payload
}

export function createBoardApi() {
  return {
    /**
     * The whole board, or just its head when `rev` is already known.
     * @param {{ rev?: number }} [options]
     */
    state(options = {}) {
      const query = Number.isInteger(options.rev) ? `?rev=${options.rev}` : ''
      return call(`state${query}`)
    },

    /** Commit the local scene. `baseRev` makes the write conditional. */
    save(body) {
      return call('save', { method: 'POST', body: JSON.stringify(body) })
    },

    /** Acknowledge one agent transaction with the scene that actually holds it. */
    commit(body) {
      return call('tx', { method: 'POST', body: JSON.stringify(body) })
    },

    /** A person preempted a transaction. */
    cancel(txId) {
      return call('cancel', { method: 'POST', body: JSON.stringify({ txId }) })
    },

    /** The board's own conversation id, created on demand by the Host. */
    chat() {
      return call('chat')
    },

    /** Start a fresh board conversation; the old one stays in the sidebar. */
    resetChat() {
      return call('chat/reset', { method: 'POST', body: '{}' })
    },
  }
}
