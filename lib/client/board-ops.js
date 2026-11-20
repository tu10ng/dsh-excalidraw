/**
 * Browser-side op application.
 *
 * The Host writes an optimistic scene so the file is always valid; the panel
 * upgrades that scene with Excalidraw's own layout engine. Every function here
 * takes the vendor bundle's helpers as a bag instead of importing it, which is
 * what keeps this module testable and the vendor load lazy.
 *
 * @module dsh-excalidraw/client/board-ops
 */

/** Every element id one op touches. */
export function idsOfOp(op) {
  if (op === null || typeof op !== 'object') return []
  if (op.op === 'create') return op.element && typeof op.element.id === 'string' ? [op.element.id] : []
  if (op.op === 'patch' || op.op === 'delete') return typeof op.id === 'string' ? [op.id] : []
  return Array.isArray(op.ids) ? op.ids : []
}

/** Whether the Host's element is still a placeholder the browser should replace. */
export function isOptimistic(element) {
  return element?.customData?.dsh?.optimistic === true
}

/**
 * The gesture gate. Deliberately wider than Excalidraw's own remote-update
 * check: dragging, box selection, and line editing all count as "under the
 * hand", because replacing an element mid-gesture is what a person feels as a
 * jump.
 */
export function isBusyElementId(id, appState) {
  if (appState === null || appState === undefined) return false
  for (const key of ['editingTextElement', 'resizingElement', 'newElement', 'multiElement', 'selectionElement']) {
    if (appState[key]?.id === id) return true
  }
  if (appState.editingLinearElement?.elementId === id) return true
  if (appState.selectedElementsAreBeingDragged === true && appState.selectedElementIds?.[id] === true) return true
  return false
}

/**
 * Apply one op to the element map, in place.
 *
 * Idempotent for replays: a create whose id already exists is skipped unless
 * the existing element is the Host's optimistic placeholder.
 *
 * @param {Map<string, object>} elements
 * @param {object} op normalized
 * @param {{ convert: Function, newElementWith: Function, now: number }} tools
 * @returns {boolean} whether anything changed
 */
export function applyClientOp(elements, op, tools) {
  if (op.op === 'create') {
    const existing = elements.get(op.element.id)
    if (existing !== undefined && !isOptimistic(existing)) return false
    const converted = tools.convert([op.element], { regenerateIds: false })
    const element = Array.isArray(converted) ? converted[0] : undefined
    if (element === undefined) return false
    elements.set(element.id, element)
    return true
  }

  const id = op.op === 'patch' || op.op === 'delete' ? op.id : undefined
  if (id !== undefined) {
    const element = elements.get(id)
    if (element === undefined) return false
    if (op.op === 'patch') {
      const next = patchElement(element, op.set, tools)
      if (next === element) return false
      elements.set(id, next)
      return true
    }
    if (element.isDeleted === true) return false
    elements.set(id, tools.newElementWith(element, { isDeleted: true }))
    return true
  }

  if (op.op === 'lock' || op.op === 'unlock') {
    let changed = false
    for (const target of op.ids) {
      const element = elements.get(target)
      if (element === undefined) continue
      const locked = op.op === 'lock'
      if (element.locked === locked) continue
      const next = tools.newElementWith(element, { locked })
      elements.set(target, withMeta(next, { lockedBy: locked ? 'agent' : undefined }))
      changed = true
    }
    return changed
  }

  return false
}

/** A property patch; text keeps its box measured by Excalidraw itself. */
export function patchElement(element, set, tools) {
  let next = tools.newElementWith(element, set)
  if (typeof set.text === 'string' && next.type === 'text') {
    const measured = measureText(next, set.text, tools.convert)
    next = { ...next, ...measured }
  }
  return next
}

function measureText(element, text, convert) {
  try {
    const [probe] = convert(
      [
        {
          type: 'text',
          text,
          x: element.x,
          y: element.y,
          fontSize: element.fontSize,
          fontFamily: element.fontFamily,
          textAlign: element.textAlign,
        },
      ],
      { regenerateIds: false },
    )
    if (probe === undefined) return {}
    return {
      originalText: text,
      width: probe.width,
      height: probe.height,
      lineHeight: probe.lineHeight,
      baseline: probe.baseline,
    }
  } catch {
    return { originalText: text }
  }
}

/**
 * Mark one element as held by a transaction. The version bump matters: the
 * server unlocks with its own bump on commit, and the panel accepts the newer
 * element by version alone.
 */
export function lockOnClient(element, lease, now) {
  const previous = element?.customData?.dsh
  const lockedBefore =
    typeof previous?.lockedBefore === 'boolean' ? previous.lockedBefore : element.locked === true
  return {
    ...withMeta(element, { lock: { txId: lease.txId, until: lease.until, since: now }, lockedBefore }),
    locked: true,
    version: element.version + 1,
    versionNonce: randomNonce(),
    updated: now,
  }
}

/** Copy plugin metadata without losing another tool's `customData`. */
export function withMeta(element, patch) {
  const data = element.customData !== null && typeof element.customData === 'object' ? element.customData : {}
  const dsh = data.dsh !== null && typeof data.dsh === 'object' ? data.dsh : {}
  const nextDsh = { ...dsh, ...patch }
  for (const key of Object.keys(nextDsh)) if (nextDsh[key] === undefined) delete nextDsh[key]
  return { ...element, customData: { ...data, dsh: nextDsh } }
}

function randomNonce() {
  return Math.floor(Math.random() * 2 ** 31)
}

/** Bindings are a list; a remind can repeat but never duplicates. */
export function bindingOf(event) {
  return {
    sessionId: event.sessionId,
    seq: event.seq,
    type: event.type,
    at: event.at,
    label: typeof event.summary === 'string' ? event.summary : '',
  }
}

/** Whether one element is bound to this exact event. */
export function hasBinding(element, binding) {
  const list = element?.customData?.dsh?.binding
  if (!Array.isArray(list)) return false
  return list.some((item) => item.sessionId === binding.sessionId && item.seq === binding.seq)
}

/** Every binding of one element, newest last. */
export function bindingsOf(element) {
  const list = element?.customData?.dsh?.binding
  return Array.isArray(list) ? list : []
}

/**
 * A cheap content fingerprint of a scene.
 *
 * Excalidraw calls `onChange` on every render, not only on edits, so identity
 * alone cannot tell an echo from a change. This compares what would be written:
 * ids, versions, and ordering. A collision only costs one skipped save of an
 * identical scene, never a lost edit.
 */
export function sceneSignature(elements) {
  let hash = 2_166_136_261
  for (const element of elements) {
    const text = `${element.id}|${element.version}|${element.versionNonce};`
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16_777_619)
    }
  }
  return `${elements.length}:${(hash >>> 0).toString(36)}`
}
