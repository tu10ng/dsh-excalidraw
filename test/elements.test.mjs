import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, createElement, dshMeta, estimateText, forceUnlock, lockElement, patchElement, summarize } from '../lib/elements.js'

test('createElement fills every field Excalidraw reads', () => {
  const element = createElement(
    { type: 'rectangle', x: 10, y: 20, width: 120, height: 80, text: 'hello' },
    { now: 1_000, random: () => 0.5 },
  )
  assert.equal(element.type, 'rectangle')
  assert.equal(element.x, 10)
  assert.equal(element.width, 120)
  assert.equal(element.version, 1)
  assert.equal(element.isDeleted, false)
  assert.equal(element.locked, false)
  assert.equal(element.customData.dsh.optimistic, true)
  assert.equal(typeof element.seed, 'number')
  assert.equal(typeof element.versionNonce, 'number')
  assert.deepEqual(element.groupIds, [])
  assert.equal(element.index, null)
})

test('text elements carry measured bounds and originalText', () => {
  const element = createElement(
    { type: 'text', x: 0, y: 0, text: '一二三', fontSize: 20 },
    { now: 1_000, random: () => 0.5 },
  )
  assert.equal(element.type, 'text')
  assert.equal(element.originalText, '一二三')
  assert.equal(element.fontSize, 20)
  assert.equal(element.width, 60)
  assert.ok(element.height >= 20)
})

test('estimateText widens for CJK and wraps on newlines', () => {
  const latin = estimateText('abcd', 20)
  const cjk = estimateText('中文', 20)
  assert.ok(cjk.width > latin.width / 2)
  const twoLines = estimateText('a\nb', 20)
  assert.ok(twoLines.height > latin.height)
})

test('arrow creation keeps a linear shape', () => {
  const element = createElement({ type: 'arrow', x: 0, y: 0, width: 100, height: 50 }, { now: 1, random: () => 0.5 })
  assert.deepEqual(element.points, [
    [0, 0],
    [100, 50],
  ])
  assert.equal(element.endArrowhead, 'arrow')
  assert.equal(element.startBinding, null)
})

test('lock records the previous state and forceUnlock restores it', () => {
  const element = createElement({ type: 'rectangle', x: 0, y: 0 }, { now: 1, random: () => 0.5 })
  const locked = lockElement(element, { txId: 'tx-1', until: 9_999, since: 1 }, 2)
  assert.equal(locked.locked, true)
  assert.equal(dshMeta(locked).lock.txId, 'tx-1')
  assert.equal(dshMeta(locked).lockedBefore, false)
  const unlocked = forceUnlock(locked, 3, true)
  assert.equal(unlocked.locked, false)
  assert.equal(dshMeta(unlocked).lock, undefined)
  assert.equal(dshMeta(unlocked).lockedBefore, undefined)
})

test('forceUnlock keeps a lock the person had set', () => {
  const element = { ...createElement({ type: 'rectangle', x: 0, y: 0 }, { now: 1, random: () => 0.5 }), locked: true }
  const locked = lockElement(element, { txId: 'tx-1', until: 9_999, since: 1 }, 2)
  const unlocked = forceUnlock(locked, 3, true)
  assert.equal(unlocked.locked, true)
  assert.equal(dshMeta(unlocked).lock, undefined)
})

test('applyOps is idempotent for a replayed transaction', () => {
  const elements = new Map()
  const ops = [
    { op: 'create', element: { type: 'rectangle', id: 'r1', x: 0, y: 0, width: 10, height: 10 } },
    { op: 'create', element: { type: 'text', id: 't1', x: 0, y: 20, text: 'hi' } },
    { op: 'patch', id: 'r1', set: { x: 40 } },
  ]
  const first = applyOps(elements, ops, { now: 1, random: () => 0.2 })
  assert.deepEqual(first.created, ['r1', 't1'])
  const versionAfterFirst = elements.get('r1').version
  const second = applyOps(elements, ops, { now: 2, random: () => 0.2 })
  assert.deepEqual(second.created, [])
  assert.equal(elements.get('r1').version, versionAfterFirst, 'replaying the same patch must not bump twice')
  assert.equal(elements.get('r1').x, 40)
})

test('patching text resizes the box', () => {
  const element = createElement({ type: 'text', x: 0, y: 0, text: 'a' }, { now: 1, random: () => 0.5 })
  const patched = patchElement(element, { text: 'a much longer line than before' }, 2, () => 0.5)
  assert.ok(patched.width > element.width)
  assert.equal(patched.originalText, 'a much longer line than before')
})

test('deleting is a tombstone, not a removal', () => {
  const elements = new Map()
  applyOps(elements, [{ op: 'create', element: { type: 'rectangle', id: 'r1', x: 0, y: 0 } }], { now: 1 })
  applyOps(elements, [{ op: 'delete', id: 'r1' }], { now: 2 })
  assert.equal(elements.get('r1').isDeleted, true)
  assert.equal(summarize(elements.get('r1')).deleted, true)
})

test('lock/unlock ops are explicit ownership', () => {
  const elements = new Map()
  applyOps(elements, [{ op: 'create', element: { type: 'rectangle', id: 'r1', x: 0, y: 0 } }], { now: 1 })
  applyOps(elements, [{ op: 'lock', ids: ['r1'] }], { now: 2 })
  assert.equal(elements.get('r1').locked, true)
  assert.equal(dshMeta(elements.get('r1')).lockedBy, 'agent')
  applyOps(elements, [{ op: 'unlock', ids: ['r1'] }], { now: 3 })
  assert.equal(elements.get('r1').locked, false)
  assert.equal(dshMeta(elements.get('r1')).lockedBy, undefined)
})
