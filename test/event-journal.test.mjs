import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventJournal } from '../lib/event-journal.js'

test('a cursor replays exactly what a reader missed', () => {
  const journal = createEventJournal({ limit: 50 })
  for (let index = 1; index <= 5; index += 1) journal.push({ type: 'x', n: index })
  const missed = journal.since(2)
  assert.equal(missed.reset, false)
  assert.deepEqual(
    missed.events.map((event) => event.n),
    [3, 4, 5],
  )
  assert.equal(missed.cursor, 5)
})

test('a reader behind the window gets a reset instead of a gap', () => {
  const journal = createEventJournal({ limit: 20 })
  for (let index = 1; index <= 30; index += 1) journal.push({ type: 'x', n: index })
  const behind = journal.since(0)
  assert.equal(behind.reset, true)
  assert.equal(behind.events.length, 20)
  assert.equal(behind.events.at(-1).n, 30)
  assert.equal(behind.floor, 11)
})

test('subscribers see each record once', () => {
  const journal = createEventJournal()
  const seen = []
  const off = journal.subscribe((record) => seen.push(record.cursor))
  journal.push({ type: 'a' })
  journal.push({ type: 'b' })
  off()
  journal.push({ type: 'c' })
  assert.deepEqual(seen, [1, 2])
  assert.equal(journal.cursor, 3)
})

test('recent keeps the newest tail', () => {
  const journal = createEventJournal()
  for (let index = 1; index <= 10; index += 1) journal.push({ n: index })
  assert.deepEqual(
    journal.recent(3).map((event) => event.n),
    [8, 9, 10],
  )
})
