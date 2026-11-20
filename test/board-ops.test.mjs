import assert from 'node:assert/strict'
import test from 'node:test'

import { applyClientOp, hasBinding, idsOfOp, isBusyElementId, sceneSignature } from '../lib/client/board-ops.js'

const tools = {
  convert: (skeletons) =>
    skeletons.map((skeleton) => ({
      id: skeleton.id ?? 'auto',
      type: skeleton.type,
      x: skeleton.x ?? 0,
      y: skeleton.y ?? 0,
      width: 100,
      height: 40,
      version: 1,
      versionNonce: 7,
      isDeleted: false,
      locked: false,
    })),
  newElementWith: (element, patch) => ({ ...element, ...patch, version: element.version + 1, versionNonce: 8 }),
  now: 1_000,
}

test('a signature ignores object identity but follows content', () => {
  const scene = [
    { id: 'a', version: 1, versionNonce: 10 },
    { id: 'b', version: 2, versionNonce: 20 },
  ]
  assert.equal(sceneSignature(scene), sceneSignature(scene.map((element) => ({ ...element }))))
  assert.notEqual(sceneSignature(scene), sceneSignature([scene[1], scene[0]]))
  assert.notEqual(sceneSignature(scene), sceneSignature([{ ...scene[0], version: 9 }, scene[1]]))
  assert.equal(sceneSignature([]), '0:ztntfp')
})

test('idsOfOp covers every op shape', () => {
  assert.deepEqual(idsOfOp({ op: 'create', element: { id: 'a' } }), ['a'])
  assert.deepEqual(idsOfOp({ op: 'patch', id: 'b', set: {} }), ['b'])
  assert.deepEqual(idsOfOp({ op: 'delete', id: 'c' }), ['c'])
  assert.deepEqual(idsOfOp({ op: 'lock', ids: ['d', 'e'] }), ['d', 'e'])
  assert.deepEqual(idsOfOp({ nope: true }), [])
})

test('the gesture gate counts every way a person can hold an element', () => {
  assert.equal(isBusyElementId('a', { editingTextElement: { id: 'a' } }), true)
  assert.equal(isBusyElementId('a', { resizingElement: { id: 'a' } }), true)
  assert.equal(isBusyElementId('a', { newElement: { id: 'a' } }), true)
  assert.equal(isBusyElementId('a', { multiElement: { id: 'a' } }), true)
  assert.equal(isBusyElementId('a', { editingLinearElement: { elementId: 'a' } }), true)
  assert.equal(isBusyElementId('a', { selectedElementsAreBeingDragged: true, selectedElementIds: { a: true } }), true)
  assert.equal(isBusyElementId('a', { selectedElementsAreBeingDragged: true, selectedElementIds: { b: true } }), false)
  assert.equal(isBusyElementId('a', null), false)
})

test('create is skipped once the id exists, except for an optimistic placeholder', () => {
  const elements = new Map()
  const op = { op: 'create', element: { id: 'r1', type: 'rectangle', x: 0, y: 0 } }
  assert.equal(applyClientOp(elements, op, tools), true)
  assert.equal(elements.get('r1').type, 'rectangle')

  elements.set('r1', { ...elements.get('r1'), type: 'ellipse' })
  assert.equal(applyClientOp(elements, op, tools), false, 'a real element is not replaced by a replay')

  elements.set('r2', { id: 'r2', type: 'rectangle', customData: { dsh: { optimistic: true } }, version: 1, versionNonce: 1 })
  assert.equal(applyClientOp(elements, { op: 'create', element: { id: 'r2', type: 'rectangle' } }, tools), true)
  assert.equal(elements.get('r2').customData, undefined, 'the placeholder gives way to the real element')
})

test('patch bumps the version, delete is a tombstone, lock is metadata', () => {
  const elements = new Map()
  applyClientOp(elements, { op: 'create', element: { id: 'r1', type: 'rectangle', x: 0, y: 0 } }, tools)
  applyClientOp(elements, { op: 'patch', id: 'r1', set: { x: 40 } }, tools)
  assert.equal(elements.get('r1').x, 40)
  assert.equal(elements.get('r1').version, 2)

  applyClientOp(elements, { op: 'delete', id: 'r1' }, tools)
  assert.equal(elements.get('r1').isDeleted, true)

  applyClientOp(elements, { op: 'lock', ids: ['r1'] }, tools)
  assert.equal(elements.get('r1').locked, true)
  assert.equal(elements.get('r1').customData.dsh.lockedBy, 'agent')

  applyClientOp(elements, { op: 'unlock', ids: ['r1'] }, tools)
  assert.equal(elements.get('r1').locked, false)
  assert.equal(elements.get('r1').customData.dsh.lockedBy, undefined)
})

test('a binding matches one exact event, not a session alone', () => {
  const element = { customData: { dsh: { binding: [{ sessionId: 's1', seq: 3, type: 'tool/result' }] } } }
  assert.equal(hasBinding(element, { sessionId: 's1', seq: 3 }), true)
  assert.equal(hasBinding(element, { sessionId: 's1', seq: 4 }), false)
  assert.equal(hasBinding({}, { sessionId: 's1', seq: 3 }), false)
})
