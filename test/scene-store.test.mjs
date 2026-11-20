import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSceneStore, SceneError } from '../lib/scene-store.js'

async function board(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-excalidraw-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const clock = { value: 1_000 }
  const store = createSceneStore({ root, board: 'main', now: () => clock.value })
  await store.ready()
  t.after(() => store.close())
  return { root, clock, store }
}

const rectangle = (id = 'r1') => ({ op: 'create', element: { type: 'rectangle', id, x: 0, y: 0, width: 100, height: 50 } })

test('a headless apply writes an unlocked element and needs no ack', async (t) => {
  const { store } = await board(t)
  const opened = await store.apply([rectangle()], { lock: false })
  assert.equal(opened.pending, false)
  assert.equal(opened.rev, 1)
  const element = store.snapshot().elements.find((item) => item.id === 'r1')
  assert.equal(element.locked, false)
  assert.equal((await opened.waitFor(5)).status, 'headless')
})

test('a locked apply holds the element until the browser commits', async (t) => {
  const { store } = await board(t)
  const opened = await store.apply([rectangle()], { lock: true, leaseMs: 5_000 })
  assert.equal(opened.pending, true)
  assert.equal(store.heldIds().length, 1)

  const held = store.snapshot().elements.find((item) => item.id === 'r1')
  assert.equal(held.locked, true)
  assert.equal(held.customData.dsh.lock.txId, opened.txId)
  assert.equal((await opened.waitFor(5)).status, 'pending')

  const committed = await store.commit(opened.txId, {
    baseRev: opened.rev,
    elements: store.snapshot().elements,
    deferred: [],
  })
  assert.equal(committed.rev, 2)
  const after = store.snapshot().elements.find((item) => item.id === 'r1')
  assert.equal(after.locked, false)
  assert.equal(after.customData.dsh.lock, undefined)
  assert.equal(store.heldIds().length, 0)
})

test('a commit against an old revision is refused with the current one', async (t) => {
  const { store } = await board(t)
  const opened = await store.apply([rectangle()], { lock: true })
  await assert.rejects(
    store.commit(opened.txId, { baseRev: opened.rev - 1, elements: store.snapshot().elements }),
    (error) => error instanceof SceneError && error.code === 'stale-revision' && error.rev === opened.rev,
  )
  // The lease is still live after a refused commit.
  assert.equal(store.heldIds().length, 1)
})

test('an expired lease unlocks the board by itself', async (t) => {
  const { store, clock } = await board(t)
  const opened = await store.apply([rectangle()], { lock: true, leaseMs: 1_000 })
  clock.value += 2_000
  await store.sweep()
  assert.equal(store.heldIds().length, 0)
  assert.equal(store.snapshot().elements.find((item) => item.id === 'r1').locked, false)
  assert.equal((await opened.waitFor(50)).status, 'expired')
  assert.equal(store.status(opened.txId).status, 'expired')
})

test('a save while an element is leased cannot unlock it', async (t) => {
  const { store } = await board(t)
  const opened = await store.apply([rectangle()], { lock: true })
  const scene = store.snapshot()
  const unlockedByClient = scene.elements.map((element) => ({ ...element, locked: false }))
  const saved = await store.save({ baseRev: opened.rev, elements: unlockedByClient })
  assert.equal(saved.rev, opened.rev + 1)
  assert.equal(store.snapshot().elements.find((item) => item.id === 'r1').locked, true)
})

test('a stale save is refused, not merged', async (t) => {
  const { store } = await board(t)
  await store.apply([rectangle()], { lock: false })
  await assert.rejects(
    store.save({ baseRev: 0, elements: [] }),
    (error) => error instanceof SceneError && error.code === 'stale-revision',
  )
})

test('two open transactions cannot lease the same element', async (t) => {
  const { store } = await board(t)
  const first = await store.apply([rectangle()], { lock: true })
  await assert.rejects(store.apply([{ op: 'patch', id: 'r1', set: { x: 30 } }], { lock: true }), /正被另一个事务持有/)
  await store.commit(first.txId, { baseRev: first.rev, elements: store.snapshot().elements })
})

test('release hands an element back before the transaction settles', async (t) => {
  const { store } = await board(t)
  const opened = await store.apply([rectangle()], { lock: true })
  const released = await store.release(['r1'])
  assert.equal(released.released, 1)
  assert.equal(store.snapshot().elements.find((item) => item.id === 'r1').locked, false)
  assert.equal((await opened.waitFor(50)).status, 'released')
})

test('the board survives a reload, rev included', async (t) => {
  const { root, store } = await board(t)
  await store.apply([rectangle('kept')], { lock: false })
  await store.close()

  const reopened = createSceneStore({ root, board: 'main', now: () => 2_000 })
  t.after(() => reopened.close())
  await reopened.ready()
  assert.equal(reopened.head().rev, 1)
  assert.equal(reopened.snapshot().elements.find((item) => item.id === 'kept').type, 'rectangle')
})

test('a lock left behind by a dead process is repaired on load', async (t) => {
  const { root, store } = await board(t)
  await store.apply([rectangle()], { lock: true })
  await store.close()

  const sceneFile = path.join(root, 'main', 'board.excalidraw')
  const scene = JSON.parse(await readFile(sceneFile, 'utf8'))
  assert.equal(scene.elements[0].locked, true)

  const reopened = createSceneStore({ root, board: 'main', now: () => 3_000 })
  t.after(() => reopened.close())
  await reopened.ready()
  assert.equal(reopened.snapshot().elements[0].locked, false)
  assert.equal(reopened.snapshot().elements[0].customData.dsh.lock, undefined)
})

test('binding lands in customData and is summarized', async (t) => {
  const { store } = await board(t)
  await store.apply([rectangle()], { lock: false })
  const bound = await store.bind(['r1'], { sessionId: 's1', seq: 4, type: 'tool/result', at: 5, label: 'done' })
  assert.deepEqual(bound.changed, ['r1'])
  const summary = store.read({ ids: ['r1'] }).elements[0]
  assert.equal(summary.binding[0].sessionId, 's1')
  assert.equal(summary.binding[0].seq, 4)
})

test('the sidecar keeps a revision and a journal, not the scene', async (t) => {
  const { root, store } = await board(t)
  await store.apply([rectangle()], { lock: false })
  const sidecar = JSON.parse(await readFile(path.join(root, 'main', 'board.dsh.json'), 'utf8'))
  assert.equal(sidecar.rev, 1)
  assert.equal(sidecar.board, 'main')
  assert.ok(Array.isArray(sidecar.journal))
  assert.equal(sidecar.elements, undefined)
  const scene = JSON.parse(await readFile(path.join(root, 'main', 'board.excalidraw'), 'utf8'))
  assert.equal(scene.type, 'excalidraw')
  assert.equal(scene.elements.length, 1)
})

test('an unreadable sidecar does not take the scene with it', async (t) => {
  const { root, store } = await board(t)
  await store.apply([rectangle()], { lock: false })
  await store.close()
  await writeFile(path.join(root, 'main', 'board.dsh.json'), '{not json', 'utf8')

  const reopened = createSceneStore({ root, board: 'main', now: () => 4_000 })
  t.after(() => reopened.close())
  await reopened.ready()
  assert.equal(reopened.head().rev, 0)
  assert.equal(reopened.snapshot().elements.length, 1)
})
