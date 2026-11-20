/**
 * Turning one `SessionEvent` into a rail row.
 *
 * Rules: never leak a whole tool result, never throw on an unknown shape (DSH
 * adds event types; this file must keep working), and mark the noisy
 * bookkeeping events as `minor` so the rail can collapse them without hiding
 * them.
 *
 * @module dsh-excalidraw/session-events
 */

import { oneLine } from './shared/protocol.js'

/** Event types the rail folds by default. Still forwarded, still inspectable. */
const MINOR = new Set([
  'step/start',
  'step/end',
  'request/header',
  'request/context',
  'session/end-seed',
  'assistant/attempt',
  'tool/ptc-dispatch',
])

/** Human label per event type; the generic fallback is the raw type. */
const LABELS = {
  'turn/start': '回合开始',
  'turn/end': '回合结束',
  'user/message': '用户',
  'assistant/message': '助手',
  'tool/call': '调用工具',
  'tool/result': '工具结果',
  'assistant/attempt': '模型尝试',
  'system/message': '系统',
  'developer/message': '开发者',
}

/**
 * @param {string} sessionId
 * @param {{ type: string, seq: number, time?: number, data?: object }} event
 * @param {{ now: number }} context
 * @returns {object | null}
 */
export function normalizeSessionEvent(sessionId, event, context) {
  if (event === null || typeof event !== 'object') return null
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  const record = {
    sessionId,
    seq: Number.isFinite(event.seq) ? event.seq : 0,
    type,
    at: Number.isFinite(event.time) ? event.time : context.now,
    label: LABELS[type] ?? type,
    minor: MINOR.has(type),
    summary: '',
  }

  if (type === 'tool/call') {
    record.tool = typeof data.name === 'string' ? data.name : 'tool'
    record.callId = typeof data.callId === 'string' ? data.callId : undefined
    record.summary = oneLine(`${record.tool} ${previewArguments(data.arguments)}`, 180)
    if (Number.isFinite(data.turn)) record.turn = data.turn
    return record
  }

  if (type === 'tool/result') {
    record.tool = toolNameOf(data)
    record.callId = typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : undefined
    record.failed = data.error !== undefined || data.message?.isError === true
    const text = messageText(data.message)
    record.summary = oneLine(text || (record.failed ? '工具失败' : '工具完成'), 180)
    if (record.failed) record.error = oneLine(data.error?.reason ?? data.error?.message ?? data.error?.code ?? 'error', 120)
    if (Number.isFinite(data.turn)) record.turn = data.turn
    return record
  }

  if (type === 'assistant/message') {
    record.summary = oneLine(messageText(data.message) || '（无文本）', 180)
    if (Number.isFinite(data.turn)) record.turn = data.turn
    if (data.interrupted === true) record.failed = true
    if (data.usage && Number.isFinite(data.usage.outputTokens)) record.tokens = data.usage.outputTokens
    return record
  }

  if (type === 'user/message') {
    record.summary = oneLine(messageText(data) || '（无文本）', 180)
    record.role = 'user'
    return record
  }

  if (type === 'turn/end') {
    const kind = data.reason?.kind ?? 'completed'
    record.summary = kind === 'completed' ? '完成' : `结束：${kind}`
    record.failed = kind === 'error' || kind === 'aborted'
    if (Number.isFinite(data.turn)) record.turn = data.turn
    return record
  }

  if (type === 'turn/start') {
    record.summary = Number.isFinite(data.turn) ? `第 ${data.turn} 回合` : '回合开始'
    if (Number.isFinite(data.turn)) record.turn = data.turn
    return record
  }

  if (type === 'assistant/attempt') {
    record.summary = '模型请求'
    if (Number.isFinite(data.turn)) record.turn = data.turn
    if (Number.isFinite(data.step)) record.step = data.step
    return record
  }

  if (type === 'system/message' || type === 'developer/message') {
    record.summary = oneLine(messageText(data.message ?? data) || '上下文更新', 120)
    return record
  }

  record.summary = oneLine(fallbackSummary(data), 120)
  return record
}

function toolNameOf(data) {
  const meta = data?.message?.meta ?? data?.meta
  if (meta !== null && typeof meta === 'object' && typeof meta.name === 'string') return meta.name
  return undefined
}

function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

/** Tool arguments are a JSON string; show the model's intent, not a wall of JSON. */
function previewArguments(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  try {
    const parsed = JSON.parse(value)
    const entries = Object.entries(parsed ?? {})
    const head = entries.slice(0, 3).map(([key, item]) => `${key}=${valueOf(item)}`)
    return oneLine(head.join(' '), 120)
  } catch {
    return oneLine(value, 120)
  }
}

function valueOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return '{…}'
  return oneLine(String(value), 40)
}

function fallbackSummary(data) {
  if (typeof data.text === 'string') return data.text
  if (typeof data.message === 'string') return data.message
  const keys = Object.keys(data)
  return keys.length === 0 ? '' : `{${keys.slice(0, 4).join(', ')}}`
}
