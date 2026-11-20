import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeOps, OpError } from '../lib/ops.js'
import { targetsOf } from '../lib/shared/protocol.js'

const context = { now: 1_000, nextId: () => 'auto-1' }

test('create gets a deterministic id when the model gives none', () => {
  const { ops, ids } = normalizeOps([{ op: 'create', element: { type: 'rectangle', x: 0, y: 0 } }], context)
  assert.equal(ops[0].element.id, 'auto-1')
  assert.deepEqual(ids, ['auto-1'])
})

test('create rejects an unknown element type', () => {
  assert.throws(
    () => normalizeOps([{ op: 'create', element: { type: 'hologram', x: 0, y: 0 } }], context),
    (error) => error instanceof OpError && error.code === 'invalid-request',
  )
})

test('create rejects unknown fields instead of dropping them', () => {
  assert.throws(
    () => normalizeOps([{ op: 'create', element: { type: 'rectangle', x: 0, glow: true } }], context),
    /不支持字段 glow/,
  )
})

test('patch refuses fields outside the contract', () => {
  assert.throws(() => normalizeOps([{ op: 'patch', id: 'r1', set: { version: 9 } }], context), /不支持字段 version/)
  assert.throws(() => normalizeOps([{ op: 'patch', id: 'r1', set: {} }], context), /不能为空/)
})

test('patch coerces and bounds strings', () => {
  const long = 'x'.repeat(5_000)
  const { ops } = normalizeOps([{ op: 'patch', id: 'r1', set: { text: long } }], context)
  assert.equal(ops[0].set.text.length, 4_000)
})

test('numbers must be finite', () => {
  assert.throws(() => normalizeOps([{ op: 'patch', id: 'r1', set: { x: Number.NaN } }], context), /有限数字/)
  assert.throws(() => normalizeOps([{ op: 'create', element: { type: 'rectangle', x: Infinity } }], context), /有限数字/)
})

test('enums are checked', () => {
  assert.throws(() => normalizeOps([{ op: 'patch', id: 'r1', set: { fillStyle: 'plaid' } }], context), /只能是/)
})

test('lock and unlock name ids', () => {
  const { ops, ids } = normalizeOps([{ op: 'lock', ids: ['a', 'b'] }], context)
  assert.deepEqual(ops[0].ids, ['a', 'b'])
  assert.deepEqual(ids, ['a', 'b'])
})

test('op count is bounded', () => {
  const many = Array.from({ length: 300 }, () => ({ op: 'delete', id: 'x' }))
  assert.throws(() => normalizeOps(many, context), /最多/)
})

test('targetsOf covers every op shape', () => {
  assert.deepEqual(
    targetsOf([
      { op: 'create', element: { id: 'a' } },
      { op: 'patch', id: 'b', set: { x: 1 } },
      { op: 'delete', id: 'c' },
      { op: 'lock', ids: ['d', 'e'] },
    ]).sort(),
    ['a', 'b', 'c', 'd', 'e'],
  )
})
