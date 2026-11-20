/**
 * The board: one directory holding a plain `.excalidraw` scene and a sidecar of
 * everything that is ours (revision, leases, journal).
 *
 * Design rules this file keeps:
 *
 * 1. **It owns the file.** Every write goes through `writeFileAtomic`, and every
 *    mutation goes through the serial queue, so one board has exactly one writer
 *    even when two tools and three tabs race.
 * 2. **It is the revision authority.** Every accepted change bumps `rev`; a
 *    client that commits against an older revision is refused with
 *    `stale-revision` and must re-read, never merge blind.
 * 3. **A lease is temporary ownership.** While a transaction holds an element,
 *    the element is `locked` in the file, so a person cannot pick it up even by
 *    accident; settling, releasing, or expiring puts back whatever the person
 *    had before.
 * 4. **The file is renderable at all times.** An optimistic element carries every
 *    field Excalidraw reads, so a board is valid even if no browser ever
 *    upgrades it.
 *
 * @module dsh-excalidraw/scene-store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from './atomic.js'
import {
  applyOps,
  assertSceneSize,
  bindElements,
  dshMeta,
  forceUnlock,
  lockElement,
  summarize,
} from './elements.js'

/** A refusal with a machine code and, when known, the current revision. */
export class SceneError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SceneError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** A board that has never been opened still has a background colour. */
const DEFAULT_APP_STATE = Object.freeze({
  viewBackgroundColor: '#ffffff',
  gridSize: 20,
  gridStep: 5,
  gridModeEnabled: false,
})

const FILE_SCENE = 'board.excalidraw'
const FILE_SIDECAR = 'board.dsh.json'
const SIDECAR_VERSION = 1
const JOURNAL_LIMIT = 120
const SETTLED_LIMIT = 50

/**
 * @param {{ root: string, board: string, now?: () => number, logger?: object }} options
 */
export function createSceneStore(options) {
  const board = options.board
  const dir = path.join(options.root, board)
  const sceneFile = path.join(dir, FILE_SCENE)
  const sidecarFile = path.join(dir, FILE_SIDECAR)
  const now = options.now ?? Date.now
  const logger = options.logger

  /** @type {{ rev: number, updatedAt: number, elements: Map<string, object>, appState: object, files: object }} */
  let state = {
    rev: 0,
    updatedAt: 0,
    elements: new Map(),
    appState: { ...DEFAULT_APP_STATE },
    files: {},
  }

  /** @type {Map<string, { id: string, txId: string, until: number, since: number }>} */
  const leases = new Map()
  /** @type {Map<string, object>} */
  const transactions = new Map()
  /** @type {Array<object>} */
  let settled = []
  /** @type {Array<object>} */
  let journal = []
  /** @type {Set<Function>} */
  const listeners = new Set()

  let loaded = false
  let queue = Promise.resolve()
  let sequence = 0

  /** Serialize every mutation. A throw is relayed to its caller and never wedges the queue. */
  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function nextTxId() {
    sequence += 1
    return `tx-${now().toString(36)}-${sequence.toString(36)}-${randomBytes(2).toString('hex')}`
  }

  const isExpired = (lease) => lease.until <= now()

  /** Wire form used by every response and SSE frame. */
  function leaseView() {
    return [...leases.values()]
      .filter((lease) => !isExpired(lease))
      .map((lease) => ({ id: lease.id, txId: lease.txId, until: lease.until, since: lease.since }))
  }

  function notify(payload) {
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (error) {
        logger?.warn?.(`dsh-excalidraw: 监听器异常：${error?.message ?? error}`)
      }
    }
  }

  function changedSince(previous) {
    const changed = []
    for (const [id, element] of state.elements) {
      const before = previous.get(id)
      if (before === undefined || before.version !== element.version || before.versionNonce !== element.versionNonce) {
        changed.push(element)
      }
    }
    return changed
  }

  function journalPush(entry) {
    journal.push({ at: now(), ...entry })
    if (journal.length > JOURNAL_LIMIT) journal = journal.slice(-JOURNAL_LIMIT)
  }

  function tail(limit = 12) {
    return journal.slice(-limit)
  }

  async function writeSidecar() {
    const payload = {
      version: SIDECAR_VERSION,
      board,
      rev: state.rev,
      updatedAt: state.updatedAt,
      leases: leaseView(),
      journal,
    }
    await writeFileAtomic(sidecarFile, `${JSON.stringify(payload, null, 2)}\n`)
  }

  async function writeScene() {
    const payload = {
      type: 'excalidraw',
      version: 2,
      source: 'dsh-excalidraw',
      elements: [...state.elements.values()],
      appState: state.appState,
      files: state.files,
    }
    await writeFileAtomic(sceneFile, JSON.stringify(payload))
  }

  async function persist() {
    await writeScene()
    await writeSidecar()
  }

  async function load() {
    await mkdir(dir, { recursive: true })
    const scene = await readJson(sceneFile)
    const sidecar = await readJson(sidecarFile)
    const elements = new Map()
    for (const element of Array.isArray(scene?.elements) ? scene.elements : []) {
      if (element && typeof element === 'object' && typeof element.id === 'string') elements.set(element.id, element)
    }
    state = {
      rev: Number.isInteger(sidecar?.rev) ? sidecar.rev : 0,
      updatedAt: Number.isInteger(sidecar?.updatedAt) ? sidecar.updatedAt : 0,
      elements,
      appState: pickAppState(scene?.appState),
      files: isRecord(scene?.files) ? scene.files : {},
    }
    journal = Array.isArray(sidecar?.journal) ? sidecar.journal.slice(-JOURNAL_LIMIT) : []

    // A previous process cannot still own a lease. Drop every hold it left behind.
    let repaired = 0
    for (const [id, element] of state.elements) {
      if (dshMeta(element)?.lock === undefined) continue
      state.elements.set(id, forceUnlock(element, now(), true))
      repaired += 1
    }
    if (repaired > 0) {
      state.rev += 1
      state.updatedAt = now()
      journalPush({ kind: 'repair', ids: repaired })
      await persist()
    }
    loaded = true
    logger?.info?.(`dsh-excalidraw: 画板 ${board} 已加载（${state.elements.size} 个元素，rev ${state.rev}）`)
  }

  function whenLoaded() {
    if (!loaded) return load()
    return Promise.resolve()
  }

  /**
   * Drop expired transactions and leases, unlocking whatever they still held.
   * Runs before every mutation, so a closed tab can never freeze a board.
   */
  async function expire() {
    const released = new Set()
    let dirty = false

    for (const [txId, tx] of [...transactions]) {
      if (tx.until > now()) continue
      for (const id of tx.ids) {
        if (leases.get(id)?.txId !== txId) continue
        leases.delete(id)
        const element = state.elements.get(id)
        if (element !== undefined) {
          state.elements.set(id, forceUnlock(element, now(), true))
          released.add(id)
        }
        dirty = true
      }
      tx.resolve({ status: 'expired' })
      transactions.delete(txId)
      settle(txId, 'expired', tx.ids)
      journalPush({ kind: 'expire', txId, ids: tx.ids })
    }

    for (const [id, lease] of [...leases]) {
      if (!isExpired(lease)) continue
      leases.delete(id)
      const element = state.elements.get(id)
      if (element !== undefined) {
        state.elements.set(id, forceUnlock(element, now(), true))
        released.add(id)
      }
      dirty = true
    }

    if (!dirty) return
    state.rev += 1
    state.updatedAt = now()
    await persist()
    notify({
      kind: 'scene',
      rev: state.rev,
      elements: [...released].map((id) => state.elements.get(id)).filter(Boolean),
      leases: leaseView(),
    })
  }

  function settle(txId, status, ids) {
    settled = [{ txId, status, ids, at: now() }, ...settled].slice(0, SETTLED_LIMIT)
  }

  async function releaseLeases(ids, txId) {
    const previous = new Map(state.elements)
    const released = []
    for (const id of ids) {
      leases.delete(id)
      const element = state.elements.get(id)
      if (element === undefined) continue
      state.elements.set(id, forceUnlock(element, now(), true))
      released.push(id)
    }
    if (txId !== undefined) transactions.delete(txId)
    return { previous, released }
  }

  const api = {
    board,
    dir,

    ready: whenLoaded,

    /** Cheap identity probe: what the panel polls to decide it must re-read. */
    head() {
      return { board, rev: state.rev, updatedAt: state.updatedAt, leases: leaseView() }
    },

    snapshot() {
      return {
        board,
        rev: state.rev,
        updatedAt: state.updatedAt,
        elements: [...state.elements.values()],
        appState: state.appState,
        files: state.files,
        leases: leaseView(),
      }
    },

    tail,

    /**
     * Open a transaction: apply its ops optimistically, take a lease on every
     * element it names, and write. The caller awaits `waitFor()` to learn
     * whether a browser acknowledged it.
     *
     * @param {object[]} ops normalized
     * @param {{ lock?: boolean, leaseMs?: number, sessionId?: string, summary?: string }} options
     */
    apply(ops, options = {}) {
      return serialize(async () => {
        await whenLoaded()
        await expire()

        const ids = targetIds(ops)
        const busy = ids.filter((id) => {
          const lease = leases.get(id)
          return lease !== undefined && !isExpired(lease)
        })
        if (busy.length > 0) {
          throw new SceneError('busy', `元素正被另一个事务持有：${busy.join(', ')}`, { ids: busy })
        }

        const nowMs = now()
        const lock = options.lock === true
        const until = nowMs + (options.leaseMs ?? 20_000)
        const txId = nextTxId()
        const previous = new Map(state.elements)
        const result = applyOps(state.elements, ops, { now: nowMs })

        if (lock) {
          for (const id of ids) {
            const element = state.elements.get(id)
            if (element === undefined) continue
            leases.set(id, { id, txId, until, since: nowMs })
            state.elements.set(id, lockElement(element, { txId, until, since: nowMs }, nowMs))
          }
        }

        state.rev += 1
        state.updatedAt = nowMs
        journalPush({ kind: 'apply', txId, summary: options.summary ?? '', ids })
        await persist()

        let resolve
        const acknowledgement = new Promise((accept) => {
          resolve = accept
        })

        if (!lock) {
          settle(txId, 'headless', ids)
          resolve({ status: 'headless' })
        } else {
          transactions.set(txId, { txId, ids, ops, until, sessionId: options.sessionId, resolve })
        }

        notify({
          kind: 'tx-open',
          rev: state.rev,
          txId,
          ops,
          ids,
          created: result.created,
          leases: leaseView(),
          elements: changedSince(previous),
        })

        return {
          txId,
          rev: state.rev,
          ids,
          created: result.created,
          missing: result.missing,
          pending: lock,
          leaseUntil: lock ? until : 0,
          /** Resolves `committed` | `cancelled` | `expired` | `pending` after the timeout. */
          waitFor: (timeoutMs) => raceTimeout(acknowledgement, timeoutMs),
        }
      })
    },

    /**
     * A browser acknowledged the transaction with the scene it actually holds.
     * The committed scene wins, then the lease is released and its elements are
     * unlocked before anyone can see an inconsistent board.
     */
    commit(txId, payload) {
      return serialize(async () => {
        await whenLoaded()
        const tx = transactions.get(txId)
        if (tx === undefined) throw new SceneError('unknown-transaction', `事务 ${txId} 不存在或已结束`)
        if (payload.baseRev !== state.rev) {
          throw new SceneError('stale-revision', `画板已是 rev ${state.rev}，请重新同步后重试`, { rev: state.rev })
        }

        const deferred = new Set(Array.isArray(payload.deferred) ? payload.deferred : [])
        const previous = new Map(state.elements)
        const next = new Map()
        for (const element of validateScene(payload.elements)) next.set(element.id, element)

        for (const id of tx.ids) {
          leases.delete(id)
          const element = next.get(id) ?? state.elements.get(id)
          if (element !== undefined) next.set(id, forceUnlock(element, now(), true))
        }

        state.elements = next
        state.appState = pickAppState(payload.appState)
        if (isRecord(payload.files)) state.files = payload.files
        state.rev += 1
        state.updatedAt = now()
        journalPush({ kind: 'commit', txId, ids: tx.ids, deferred: [...deferred] })
        await persist()

        tx.resolve({ status: 'committed', deferred: [...deferred] })
        transactions.delete(txId)
        settle(txId, 'committed', tx.ids)

        notify({
          kind: 'tx-settled',
          rev: state.rev,
          txId,
          status: 'committed',
          ids: tx.ids,
          deferred: [...deferred],
          leases: leaseView(),
          elements: changedSince(previous),
        })
        return { rev: state.rev, deferred: [...deferred] }
      })
    },

    /** Refuse a transaction: unlock, write, tell the panel. */
    abort(txId, reason = 'cancelled') {
      return serialize(async () => {
        await whenLoaded()
        const tx = transactions.get(txId)
        if (tx === undefined) return { rev: state.rev, changed: false }
        const { previous, released } = await releaseLeases(tx.ids, txId)
        state.rev += 1
        state.updatedAt = now()
        journalPush({ kind: reason, txId, ids: tx.ids })
        await persist()

        tx.resolve({ status: reason })
        settle(txId, reason, tx.ids)
        notify({
          kind: 'tx-settled',
          rev: state.rev,
          txId,
          status: reason,
          ids: tx.ids,
          deferred: [],
          leases: leaseView(),
          elements: changedSince(previous),
        })
        return { rev: state.rev, released: released.length }
      })
    },

    /**
     * A person saved the canvas. Stale saves are refused, never merged blind.
     * Elements under a live lease are re-locked, so a tab that has not yet seen
     * the lease cannot hand the agent's element back to the pointer.
     */
    save(payload) {
      return serialize(async () => {
        await whenLoaded()
        await expire()
        if (payload.baseRev !== state.rev) {
          throw new SceneError('stale-revision', `画板已是 rev ${state.rev}，请重新同步后重试`, { rev: state.rev })
        }

        const previous = new Map(state.elements)
        const next = new Map()
        for (const element of validateScene(payload.elements)) next.set(element.id, element)

        const nowMs = now()
        for (const [id, lease] of leases) {
          if (isExpired(lease)) continue
          const element = next.get(id)
          if (element === undefined) continue
          if (element.locked === true && dshMeta(element)?.lock !== undefined) continue
          next.set(id, lockElement(element, lease, nowMs))
        }

        state.elements = next
        state.appState = pickAppState(payload.appState)
        if (isRecord(payload.files)) state.files = payload.files
        state.rev += 1
        state.updatedAt = nowMs
        await persist()

        notify({
          kind: 'scene',
          rev: state.rev,
          elements: changedSince(previous),
          leases: leaseView(),
        })
        return { rev: state.rev }
      })
    },

    /** Give an element back early, from the panel or from the model. */
    release(ids) {
      return serialize(async () => {
        await whenLoaded()
        const targets = ids === 'all' ? [...leases.keys()] : ids
        if (targets.length === 0) return { rev: state.rev, released: 0 }

        const owners = new Set()
        for (const id of targets) {
          const lease = leases.get(id)
          if (lease !== undefined) owners.add(lease.txId)
        }

        const { previous, released } = await releaseLeases(targets)
        if (released.length === 0) return { rev: state.rev, released: 0 }

        // A transaction whose last element was handed back is over: tell its waiter now.
        for (const txId of owners) {
          const tx = transactions.get(txId)
          if (tx === undefined) continue
          if (tx.ids.some((id) => leases.has(id))) continue
          tx.resolve({ status: 'released' })
          transactions.delete(txId)
          settle(txId, 'released', tx.ids)
        }

        state.rev += 1
        state.updatedAt = now()
        journalPush({ kind: 'release', ids: released })
        await persist()
        notify({ kind: 'scene', rev: state.rev, elements: changedSince(previous), leases: leaseView() })
        return { rev: state.rev, released: released.length }
      })
    },

    /** Bind elements to one session event; the binding lives in `customData`. */
    bind(ids, binding) {
      return serialize(async () => {
        await whenLoaded()
        const previous = new Map(state.elements)
        const changed = bindElements(state.elements, ids, binding)
        if (changed.length === 0) return { rev: state.rev, changed: [] }
        state.rev += 1
        state.updatedAt = now()
        journalPush({ kind: 'bind', ids: changed })
        await persist()
        notify({ kind: 'scene', rev: state.rev, elements: changedSince(previous), leases: leaseView() })
        return { rev: state.rev, changed }
      })
    },

    /** The summary the model reads. */
    read({ ids, limit = 200 } = {}) {
      const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : undefined
      const all = [...state.elements.values()].filter((element) => element.isDeleted !== true)
      const selected = wanted === undefined ? all : all.filter((element) => wanted.has(element.id))
      return {
        board,
        rev: state.rev,
        updatedAt: state.updatedAt,
        total: all.length,
        elements: selected.slice(0, limit).map(summarize),
        truncated: selected.length > limit,
        leases: leaseView(),
        recent: tail(8),
      }
    },

    /** Full JSON for named ids, or every element when `all`. */
    readFull({ ids, all = false } = {}) {
      const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : undefined
      const elements = [...state.elements.values()].filter((element) => {
        if (all) return true
        if (element.isDeleted === true) return false
        return wanted === undefined ? true : wanted.has(element.id)
      })
      return { board, rev: state.rev, elements }
    },

    /** Element ids currently leased. */
    heldIds() {
      return [...leases.keys()]
    },

    /** Status of one transaction, while it is open or for the recent past. */
    status(txId) {
      const open = transactions.get(txId)
      if (open !== undefined) return { txId, status: 'pending', ids: open.ids, until: open.until }
      return settled.find((item) => item.txId === txId) ?? { txId, status: 'unknown' }
    },

    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Timer hook: expire leases so a closed tab cannot freeze a board. */
    sweep() {
      return serialize(async () => {
        await whenLoaded()
        await expire()
      })
    },

    async close() {
      listeners.clear()
      await queue.catch(() => undefined)
    },
  }

  return api
}

/** Every element id an op list touches. */
function targetIds(ops) {
  const ids = new Set()
  for (const op of ops) {
    if (op.op === 'create') ids.add(op.element.id)
    else if (op.op === 'patch' || op.op === 'delete') ids.add(op.id)
    else for (const id of op.ids) ids.add(id)
  }
  return [...ids]
}

function validateScene(elements) {
  if (!Array.isArray(elements)) throw new SceneError('invalid-request', 'elements 必须是数组')
  assertSceneSize(elements)
  for (const element of elements) {
    if (element === null || typeof element !== 'object' || typeof element.id !== 'string' || element.id === '') {
      throw new SceneError('invalid-request', '每个元素必须有字符串 id')
    }
  }
  return elements
}

function pickAppState(value) {
  const next = { ...DEFAULT_APP_STATE }
  if (!isRecord(value)) return next
  for (const key of ['viewBackgroundColor', 'gridSize', 'gridStep', 'gridModeEnabled']) {
    if (value[key] !== undefined) next[key] = value[key]
  }
  return next
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Resolve with `{ status: 'pending' }` when the browser is slower than the caller's patience. */
function raceTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((accept) => {
    timer = setTimeout(() => accept({ status: 'pending' }), Math.max(0, timeoutMs))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function readJson(file) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}
