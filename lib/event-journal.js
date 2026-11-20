/**
 * The live event rail's memory: a bounded, cursor-addressed window over the
 * session events the Host forwarded.
 *
 * The cursor is what makes reconnection cheap: a panel that reconnects asks
 * `since(lastCursor)` and replays exactly what it missed, or is told to reset
 * with a fresh window when the gap fell out of the buffer.
 *
 * @module dsh-excalidraw/event-journal
 */

/** How many events the rail keeps. A drawing does not need the whole log. */
export const DEFAULT_LIMIT = 400

/**
 * @param {{ limit?: number }} [options]
 */
export function createEventJournal(options = {}) {
  const limit = Math.max(20, options.limit ?? DEFAULT_LIMIT)
  /** @type {Array<object>} */
  let events = []
  let cursor = 0
  /** @type {Set<Function>} */
  const listeners = new Set()

  function publish(record) {
    for (const listener of [...listeners]) {
      try {
        listener(record)
      } catch {
        // A rail tile must never break the event feed.
      }
    }
  }

  return {
    get cursor() {
      return cursor
    },

    /** Oldest cursor still replayable; a reader behind it needs a full reset. */
    get floor() {
      return events.length === 0 ? cursor : events[0].cursor
    },

    push(input) {
      cursor += 1
      const record = { ...input, cursor }
      events.push(record)
      if (events.length > limit) events = events.slice(-limit)
      publish(record)
      return record
    },

    /** Everything after `after`, plus whether the request fell off the buffer. */
    since(after) {
      const from = Number.isInteger(after) ? after : 0
      if (from < this.floor - 1) return { reset: true, cursor, floor: this.floor, events: [...events] }
      return { reset: false, cursor, floor: this.floor, events: events.filter((event) => event.cursor > from) }
    },

    recent(count = 60) {
      return events.slice(-Math.max(1, count))
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    clear() {
      events = []
      cursor = 0
    },
  }
}
