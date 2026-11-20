/**
 * Element model: the one place that knows how to turn an agent-authored
 * skeleton into an Excalidraw element, and how a lock lives on one.
 *
 * Pure functions over plain JSON. The Host uses them to write an optimistic
 * scene it can serve before any browser sees the transaction; the browser
 * upgrades those optimistic elements with Excalidraw's own layout engine and
 * commits the result back. Nothing here imports Node or the DOM.
 *
 * @module dsh-excalidraw/elements
 */

import { clampText, LIMITS } from './shared/protocol.js'

/** Excalidraw's own defaults, mirrored so an optimistic element renders. */
export const DEFAULTS = Object.freeze({
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  fontSize: 20,
  fontFamily: 5,
  textAlign: 'left',
  verticalAlign: 'top',
  lineHeight: 1.25,
})

/** Metadata namespace this plugin owns inside `element.customData`. */
const DSH = 'dsh'

const NON_TEXT_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])
const LINEAR_TYPES = new Set(['arrow', 'line'])

/** A stable-ish id with Excalidraw's own alphabet; ids only have to be unique per board. */
export function elementId(random = Math.random) {
  let out = ''
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let index = 0; index < 16; index += 1) out += alphabet[Math.floor(random() * alphabet.length)]
  return out
}

/** One integer in Excalidraw's nonce range. */
function nonce(random = Math.random) {
  return Math.floor(random() * 2 ** 31)
}

/** Read the plugin-owned metadata bag of one element. */
export function dshMeta(element) {
  const data = element && typeof element === 'object' ? element.customData : undefined
  const dsh = data && typeof data === 'object' ? data[DSH] : undefined
  return dsh && typeof dsh === 'object' ? dsh : undefined
}

/** Return a copy of `element` with `patch` merged into its plugin metadata. */
export function withDshMeta(element, patch) {
  const previous = element.customData && typeof element.customData === 'object' ? element.customData : {}
  const current = dshMeta(element) ?? {}
  return {
    ...element,
    customData: { ...previous, [DSH]: { ...current, ...patch } },
  }
}

/** Drop one metadata key; the bag disappears when it becomes empty. */
function withoutDshMeta(element, key) {
  const dsh = dshMeta(element)
  if (dsh === undefined || !(key in dsh)) return element
  const nextDsh = { ...dsh }
  delete nextDsh[key]
  const data = element.customData && typeof element.customData === 'object' ? element.customData : {}
  const nextData = { ...data }
  if (Object.keys(nextDsh).length === 0) delete nextData[DSH]
  else nextData[DSH] = nextDsh
  if (Object.keys(nextData).length === 0) {
    const { customData: _drop, ...rest } = element
    return rest
  }
  return { ...element, customData: nextData }
}

/** Whether a character occupies a full em (CJK, fullwidth forms, emoji). */
function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  )
}

/**
 * A text box estimate. The browser replaces it with real metrics the moment it
 * applies the transaction, so this only has to look sane before that.
 */
export function estimateText(text, fontSize = DEFAULTS.fontSize) {
  const lines = String(text ?? '').split('\n')
  let widest = 0
  for (const line of lines) {
    let width = 0
    for (const character of line) width += isWide(character.codePointAt(0) ?? 0) ? fontSize : fontSize * 0.55
    widest = Math.max(widest, width)
  }
  return {
    width: Math.max(fontSize, Math.ceil(widest)),
    height: Math.max(fontSize, Math.ceil(fontSize * DEFAULTS.lineHeight * lines.length)),
  }
}

/** The skeleton keys `create` understands; anything else is refused by `normalizeOps`. */
export const SKELETON_KEYS = Object.freeze([
  'type',
  'id',
  'x',
  'y',
  'width',
  'height',
  'angle',
  'text',
  'fontSize',
  'fontFamily',
  'textAlign',
  'verticalAlign',
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
  'roundness',
  'link',
])

/**
 * Build one optimistic element from a validated skeleton.
 *
 * Every field Excalidraw reads is present, so the JSON on disk is renderable
 * even when no browser ever upgrades it. `customData.dsh.optimistic` marks it
 * for that upgrade.
 *
 * @param {object} skeleton validated create payload
 * @param {{ now: number, random?: () => number, id?: string }} context
 */
export function createElement(skeleton, context) {
  const random = context.random ?? Math.random
  const now = context.now
  const id = skeleton.id ?? context.id ?? elementId(random)
  const type = skeleton.type
  const label = typeof skeleton.text === 'string' && skeleton.text !== '' ? clampText(skeleton.text) : undefined
  const text = type === 'text' ? label ?? '文本' : undefined
  const size = text === undefined ? undefined : estimateText(text, skeleton.fontSize ?? DEFAULTS.fontSize)

  const base = {
    id,
    type,
    x: finite(skeleton.x, 0),
    y: finite(skeleton.y, 0),
    width: finite(skeleton.width, size?.width ?? 160),
    height: finite(skeleton.height, size?.height ?? 90),
    angle: finite(skeleton.angle, 0),
    strokeColor: color(skeleton.strokeColor, DEFAULTS.strokeColor),
    backgroundColor: color(skeleton.backgroundColor, DEFAULTS.backgroundColor),
    fillStyle: skeleton.fillStyle ?? DEFAULTS.fillStyle,
    strokeWidth: finite(skeleton.strokeWidth, DEFAULTS.strokeWidth),
    strokeStyle: skeleton.strokeStyle ?? DEFAULTS.strokeStyle,
    roughness: finite(skeleton.roughness, DEFAULTS.roughness),
    opacity: finite(skeleton.opacity, DEFAULTS.opacity),
    groupIds: [],
    frameId: null,
    index: null,
    roundness: skeleton.roundness ?? null,
    seed: nonce(random),
    version: 1,
    versionNonce: nonce(random),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: typeof skeleton.link === 'string' ? skeleton.link : null,
    locked: false,
    customData: { [DSH]: { origin: 'agent', optimistic: true } },
  }

  if (NON_TEXT_TYPES.has(type)) {
    if (label !== undefined) {
      base.customData[DSH].label = label
    }
    return base
  }

  if (type === 'text') {
    return {
      ...base,
      width: finite(skeleton.width, size?.width ?? 160),
      height: finite(skeleton.height, size?.height ?? 30),
      text,
      originalText: text,
      fontSize: finite(skeleton.fontSize, DEFAULTS.fontSize),
      fontFamily: finite(skeleton.fontFamily, DEFAULTS.fontFamily),
      textAlign: skeleton.textAlign ?? DEFAULTS.textAlign,
      verticalAlign: skeleton.verticalAlign ?? DEFAULTS.verticalAlign,
      lineHeight: DEFAULTS.lineHeight,
      containerId: null,
      autoResize: true,
    }
  }

  if (LINEAR_TYPES.has(type)) {
    const width = finite(skeleton.width, 160)
    const height = finite(skeleton.height, 0)
    return {
      ...base,
      width,
      height,
      points: [
        [0, 0],
        [width, height],
      ],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: type === 'arrow' ? 'arrow' : null,
    }
  }

  if (type === 'frame') {
    return { ...base, name: label ?? 'Frame' }
  }

  return base
}

/** Text elements are the only ones whose box follows the string. */
function resizeForText(element, text, fontSize) {
  const size = estimateText(text, fontSize)
  return { ...element, text, originalText: text, width: size.width, height: size.height }
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function color(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** Mark one element as held by a transaction, remembering what the person had chosen. */
export function lockElement(element, lease, now) {
  const meta = dshMeta(element) ?? {}
  const previous = typeof meta.lockedBefore === 'boolean' ? meta.lockedBefore : element.locked === true
  return {
    ...withDshMeta(element, {
      lock: { txId: lease.txId, until: lease.until, since: lease.since ?? now },
      lockedBefore: previous,
    }),
    locked: true,
    version: element.version + 1,
    versionNonce: nonce(),
    updated: now,
  }
}

/**
 * Release a transaction's hold, restoring a lock the person had set themselves.
 *
 * `force` ignores whether the lock metadata survived: a committed scene may
 * carry an element the browser rebuilt, and a lease must never leave a board
 * locked after it ends.
 */
export function forceUnlock(element, now, force = false) {
  const meta = dshMeta(element)
  if (!force && meta?.lock === undefined) return element
  // A person's own lock, or a lock the agent asked for, outlives the lease.
  const userLocked = meta?.lockedBefore === true || meta?.lockedBy === 'agent'
  const stripped = withoutDshMeta(withoutDshMeta({ ...element, locked: userLocked }, 'lockedBefore'), 'lock')
  return { ...stripped, locked: userLocked, version: element.version + 1, versionNonce: nonce(), updated: now }
}

/**
 * Apply normalized ops to an element map, in place.
 *
 * Idempotent by construction: creating an id that already exists is a no-op,
 * patching the same value twice lands on the same element, deleting twice is
 * still deleted. The browser replays these ops after a stale-revision retry.
 *
 * @param {Map<string, object>} elements
 * @param {object[]} ops normalized
 * @param {{ now: number, random?: () => number }} context
 */
export function applyOps(elements, ops, context) {
  const now = context.now
  const random = context.random ?? Math.random
  const changed = new Set()
  const created = []
  const missing = []

  for (const op of ops) {
    if (op.op === 'create') {
      if (elements.has(op.element.id)) continue
      const element = createElement(op.element, { now, random, id: op.element.id })
      elements.set(element.id, element)
      changed.add(element.id)
      created.push(element.id)
      continue
    }

    if (op.op === 'patch') {
      const element = elements.get(op.id)
      if (element === undefined) {
        missing.push(op.id)
        continue
      }
      const next = patchElement(element, op.set, now, random)
      if (next === element) continue
      elements.set(next.id, next)
      changed.add(next.id)
      continue
    }

    if (op.op === 'delete') {
      const element = elements.get(op.id)
      if (element === undefined) {
        missing.push(op.id)
        continue
      }
      if (element.isDeleted) continue
      elements.set(element.id, bump({ ...element, isDeleted: true }, now, random))
      changed.add(element.id)
      continue
    }

    if (op.op === 'lock' || op.op === 'unlock') {
      for (const id of op.ids) {
        const element = elements.get(id)
        if (element === undefined) {
          missing.push(id)
          continue
        }
        const locked = op.op === 'lock'
        if (element.locked === locked) continue
        const next = withDshMeta(bump({ ...element, locked }, now, random), { lockedBy: locked ? 'agent' : undefined })
        elements.set(next.id, locked ? next : withoutDshMeta(next, 'lockedBy'))
        changed.add(next.id)
      }
    }
  }

  return { changed: [...changed], created, missing }
}

/** Apply a validated property patch; text keeps its box in sync. */
export function patchElement(element, set, now, random = Math.random) {
  let next = element
  let dirty = false
  for (const [key, value] of Object.entries(set)) {
    if (next[key] === value) continue
    next = next === element ? { ...element } : next
    next[key] = value
    dirty = true
  }
  if (!dirty) return element
  if (next.type === 'text' && typeof set.text === 'string') {
    next = resizeForText(next, set.text, next.fontSize ?? DEFAULTS.fontSize)
  }
  return bump(next, now, random)
}

function bump(element, now, random) {
  return {
    ...element,
    version: (element.version ?? 1) + 1,
    versionNonce: nonce(random),
    updated: now,
  }
}

/** Bind element ids to one session event; `label` is a human hint, not authority. */
export function bindElements(elements, ids, binding) {
  const changed = []
  for (const id of ids) {
    const element = elements.get(id)
    if (element === undefined) continue
    const meta = dshMeta(element) ?? {}
    const existing = Array.isArray(meta.binding) ? meta.binding : []
    const deduped = existing.filter(
      (item) => !(item.sessionId === binding.sessionId && item.seq === binding.seq && item.type === binding.type),
    )
    const next = withDshMeta(
      { ...element, version: element.version + 1, versionNonce: nonce(), updated: binding.at },
      { binding: [...deduped, binding].slice(-8) },
    )
    elements.set(id, next)
    changed.push(id)
  }
  return changed
}

/** The compact form `excalidraw_read` prints, and the panel shows in a chip. */
export function summarize(element) {
  const meta = dshMeta(element) ?? {}
  const label = typeof element.text === 'string' && element.text !== '' ? element.text : meta.label
  const summary = {
    id: element.id,
    type: element.type,
    x: Math.round(element.x),
    y: Math.round(element.y),
    width: Math.round(element.width),
    height: Math.round(element.height),
  }
  if (typeof label === 'string' && label !== '') summary.text = clampText(label, 120)
  if (element.locked) summary.locked = true
  if (meta.lock !== undefined) summary.held = meta.lock.txId
  if (meta.origin === 'agent') summary.origin = 'agent'
  if (Array.isArray(meta.binding) && meta.binding.length > 0) summary.binding = meta.binding
  if (element.isDeleted) summary.deleted = true
  return summary
}

/** Keep a committed scene inside the protocol bounds. */
export function assertSceneSize(elements) {
  if (elements.length > LIMITS.elements) {
    const error = new Error(`场景元素超过 ${LIMITS.elements} 个`)
    error.code = 'invalid-request'
    throw error
  }
}
