/**
 * Op validation. The model writes ops; this is the only door they pass through.
 *
 * Validation is strict on purpose: unknown keys, wrong types, and out-of-range
 * numbers are refused with a code the tool turns into one readable line, rather
 * than silently dropped and discovered later as a wrong drawing.
 *
 * @module dsh-excalidraw/ops
 */

import {
  clampText,
  CREATABLE,
  LIMITS,
  oneLine,
  PATCHABLE,
  targetsOf,
} from './shared/protocol.js'
import { elementId, SKELETON_KEYS } from './elements.js'

/** A refusal the tool reports to the model as `{ ok: false, reason, error }`. */
export class OpError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OpError'
    this.code = code
  }
}

const NUMERIC = new Set([
  'x',
  'y',
  'width',
  'height',
  'angle',
  'fontSize',
  'fontFamily',
  'strokeWidth',
  'roughness',
  'opacity',
])
const TEXTS = new Set(['text', 'strokeColor', 'backgroundColor', 'link'])
const ENUMS = {
  fillStyle: ['hachure', 'cross-hatch', 'solid', 'zigzag', 'dots', 'dashed', 'zigzag-line'],
  strokeStyle: ['solid', 'dashed', 'dotted'],
  textAlign: ['left', 'center', 'right'],
  verticalAlign: ['top', 'middle', 'bottom'],
}

/** Every error code the owner of this module raises. */
export const OP_ERROR = Object.freeze({
  invalid: 'invalid-request',
})

/**
 * Validate and canonicalize the agent's ops.
 *
 * @param {unknown} raw
 * @param {{ now: number, random?: () => number, nextId?: () => string }} context
 * @returns {{ ops: object[], ids: string[], creates: string[] }}
 */
export function normalizeOps(raw, context) {
  if (!Array.isArray(raw) || raw.length === 0) throw new OpError(OP_ERROR.invalid, 'ops 不能为空')
  if (raw.length > LIMITS.ops) throw new OpError(OP_ERROR.invalid, `一次最多 ${LIMITS.ops} 个操作`)

  const nextId = context.nextId ?? (() => elementId(context.random ?? Math.random))
  const ops = []
  for (const [index, value] of raw.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new OpError(OP_ERROR.invalid, `ops[${index}] 必须是对象`)
    }
    const kind = value.op
    if (kind === 'create') ops.push({ op: 'create', element: normalizeSkeleton(value.element, nextId, index) })
    else if (kind === 'patch') ops.push(normalizePatch(value, index))
    else if (kind === 'delete') ops.push({ op: 'delete', id: requireId(value.id, `ops[${index}].id`) })
    else if (kind === 'lock' || kind === 'unlock') {
      const ids = requireIds(value.ids, `ops[${index}].ids`)
      ops.push({ op: kind, ids })
    } else throw new OpError(OP_ERROR.invalid, `ops[${index}].op 只能是 create / patch / delete / lock / unlock`)
  }

  const ids = targetsOf(ops)
  const creates = ops.filter((op) => op.op === 'create').map((op) => op.element.id)
  return { ops, ids, creates }
}

function normalizeSkeleton(raw, nextId, index) {
  const where = `ops[${index}].element`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpError(OP_ERROR.invalid, `${where} 必须是对象`)
  }
  rejectUnknown(raw, SKELETON_KEYS, where)
  if (!CREATABLE.includes(raw.type)) {
    throw new OpError(OP_ERROR.invalid, `${where}.type 只能是 ${CREATABLE.join(' / ')}`)
  }
  const skeleton = { type: raw.type, id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : nextId() }
  for (const key of ['x', 'y', 'width', 'height', 'angle', 'fontSize', 'fontFamily', 'strokeWidth', 'roughness', 'opacity']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      throw new OpError(OP_ERROR.invalid, `${where}.${key} 必须是有限数字`)
    }
    skeleton[key] = raw[key]
  }
  if (raw.text !== undefined) skeleton.text = clampText(asString(raw.text, `${where}.text`))
  for (const key of ['strokeColor', 'backgroundColor', 'link']) {
    if (raw[key] !== undefined) skeleton[key] = clampText(asString(raw[key], `${where}.${key}`), 200)
  }
  if (raw.fillStyle !== undefined) skeleton.fillStyle = asEnum(raw.fillStyle, ENUMS.fillStyle, `${where}.fillStyle`)
  if (raw.strokeStyle !== undefined) skeleton.strokeStyle = asEnum(raw.strokeStyle, ENUMS.strokeStyle, `${where}.strokeStyle`)
  if (raw.textAlign !== undefined) skeleton.textAlign = asEnum(raw.textAlign, ENUMS.textAlign, `${where}.textAlign`)
  if (raw.verticalAlign !== undefined) skeleton.verticalAlign = asEnum(raw.verticalAlign, ENUMS.verticalAlign, `${where}.verticalAlign`)
  if (raw.roundness !== undefined) skeleton.roundness = raw.roundness ?? null
  return skeleton
}

function normalizePatch(raw, index) {
  const where = `ops[${index}]`
  const id = requireId(raw.id, `${where}.id`)
  if (raw.set === null || typeof raw.set !== 'object' || Array.isArray(raw.set)) {
    throw new OpError(OP_ERROR.invalid, `${where}.set 必须是对象`)
  }
  rejectUnknown(raw.set, PATCHABLE, `${where}.set`)
  const set = {}
  for (const [key, value] of Object.entries(raw.set)) {
    if (value === undefined) continue
    if (NUMERIC.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new OpError(OP_ERROR.invalid, `${where}.set.${key} 必须是有限数字`)
      }
      set[key] = value
    } else if (TEXTS.has(key)) {
      set[key] = clampText(asString(value, `${where}.set.${key}`), key === 'text' ? LIMITS.text : 200)
    } else if (key in ENUMS) {
      set[key] = asEnum(value, ENUMS[key], `${where}.set.${key}`)
    } else {
      throw new OpError(OP_ERROR.invalid, `${where}.set.${key} 不支持`)
    }
  }
  if (Object.keys(set).length === 0) throw new OpError(OP_ERROR.invalid, `${where}.set 不能为空`)
  return { op: 'patch', id, set }
}

function requireId(value, where) {
  if (typeof value !== 'string' || value === '') throw new OpError(OP_ERROR.invalid, `${where} 必须是非空字符串`)
  return value
}

function requireIds(value, where) {
  if (!Array.isArray(value) || value.length === 0) throw new OpError(OP_ERROR.invalid, `${where} 必须是非空数组`)
  if (value.length > LIMITS.ids) throw new OpError(OP_ERROR.invalid, `${where} 一次最多 ${LIMITS.ids} 个`)
  return value.map((id, index) => requireId(id, `${where}[${index}]`))
}

function rejectUnknown(value, allowed, where) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new OpError(OP_ERROR.invalid, `${where} 不支持字段 ${unknown.join(', ')}`)
}

function asString(value, where) {
  if (typeof value !== 'string') throw new OpError(OP_ERROR.invalid, `${where} 必须是字符串`)
  return value
}

function asEnum(value, allowed, where) {
  if (!allowed.includes(value)) throw new OpError(OP_ERROR.invalid, `${where} 只能是 ${allowed.join(' / ')}`)
  return value
}

/** One line per op, for the tool's text rendering and the Host journal. */
export function describeOps(ops) {
  return ops
    .map((op) => {
      if (op.op === 'create') return `create ${op.element.type} ${op.element.id}`
      if (op.op === 'patch') return `patch ${op.id} (${Object.keys(op.set).join(',')})`
      if (op.op === 'delete') return `delete ${op.id}`
      return `${op.op} ${op.ids.join(',')}`
    })
    .join('; ')
}

/** The first human-readable line of a normalized op list. */
export function summarizeOps(ops) {
  return oneLine(describeOps(ops), 120)
}
