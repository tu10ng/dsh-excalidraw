/**
 * Who is watching the board.
 *
 * The panel is the only reader. Its SSE connection is the signal that a person
 * is present, and presence is what decides whether a transaction takes locks at
 * all: locking an element nobody can touch is pure cost, and a headless run
 * must never leave a board held.
 *
 * @module dsh-excalidraw/presence
 */

export function createPresence() {
  let count = 0
  /** @type {Set<Function>} */
  const listeners = new Set()

  function publish() {
    for (const listener of [...listeners]) {
      try {
        listener(count)
      } catch {
        // Presence is advisory; a bad listener must not drop a connection.
      }
    }
  }

  return {
    /** Called once per accepted SSE connection. */
    enter() {
      count += 1
      publish()
      return () => {
        count = Math.max(0, count - 1)
        publish()
      }
    },

    get count() {
      return count
    },

    get connected() {
      return count > 0
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
