import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSessionEvent } from '../lib/session-events.js'

const now = 5_000

test('a user message becomes a rail row with its text', () => {
  const record = normalizeSessionEvent('s1', {
    type: 'user/message',
    seq: 3,
    time: 100,
    data: { role: 'user', content: [{ type: 'text', text: '帮我把这个流程画出来' }] },
  }, { now })
  assert.equal(record.summary, '帮我把这个流程画出来')
  assert.equal(record.seq, 3)
  assert.equal(record.label, '用户')
  assert.equal(record.at, 100)
})

test('a tool call shows the tool and a compact argument preview', () => {
  const record = normalizeSessionEvent('s1', {
    type: 'tool/call',
    seq: 4,
    data: { turn: 1, step: 2, callId: 'c1', name: 'write', arguments: '{"path":"a.md","content":"hello"}' },
  }, { now })
  assert.equal(record.tool, 'write')
  assert.match(record.summary, /path=a\.md/)
  assert.equal(record.turn, 1)
})

test('a failed tool result carries the reason', () => {
  const record = normalizeSessionEvent('s1', {
    type: 'tool/result',
    seq: 5,
    data: {
      turn: 1,
      step: 2,
      message: { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'ENOENT' }] },
      error: { name: 'Error', code: 'ENOENT', reason: 'missing' },
    },
  }, { now })
  assert.equal(record.failed, true)
  assert.equal(record.error, 'missing')
  assert.equal(record.callId, 'c1')
})

test('an unknown event still becomes a row', () => {
  const record = normalizeSessionEvent('s1', { type: 'future/thing', seq: 9, data: { alpha: 1, beta: 2 } }, { now })
  assert.equal(record.type, 'future/thing')
  assert.equal(record.summary, '{alpha, beta}')
  assert.equal(record.at, now)
})

test('bookkeeping events are marked minor, not dropped', () => {
  const record = normalizeSessionEvent('s1', { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }, { now })
  assert.equal(record.minor, true)
})

test('a malformed event does not throw', () => {
  assert.doesNotThrow(() => normalizeSessionEvent('s1', { type: 'turn/end', seq: 1 }, { now }))
  assert.doesNotThrow(() => normalizeSessionEvent('s1', { type: 'assistant/message', seq: 1, data: { message: null } }, { now }))
})

test('turn end reports its reason', () => {
  const record = normalizeSessionEvent('s1', {
    type: 'turn/end',
    seq: 2,
    data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } },
  }, { now })
  assert.equal(record.failed, true)
  assert.equal(record.summary, '结束：error')
})
