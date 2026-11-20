/**
 * The wire contract shared by all three halves: Host tools, the Host HTTP
 * surface, and the browser panel.
 *
 * This file has **no imports** and no side effects. Node imports it as ESM and
 * the asset route serves the very same bytes to the browser, so a route name,
 * an op kind, or a limit is written down once.
 *
 * @module dsh-excalidraw/shared/protocol
 */

/** Route prefix registered on the Host's web server. */
export const ROUTE_BASE = '/api/excalidraw'

/** The same prefix, document-relative: what the browser fetches. */
export const CLIENT_BASE = 'api/excalidraw'

/** Named HTTP routes. Keep in sync with `lib/routes.js`. */
export const ROUTES = Object.freeze({
  state: `${ROUTE_BASE}/state`,
  save: `${ROUTE_BASE}/save`,
  tx: `${ROUTE_BASE}/tx`,
  cancel: `${ROUTE_BASE}/cancel`,
  stream: `${ROUTE_BASE}/stream`,
  chat: `${ROUTE_BASE}/chat`,
  chatReset: `${ROUTE_BASE}/chat/reset`,
  assets: `${ROUTE_BASE}/assets`,
})

/** Client-relative asset directory, for `<script>`, `<link>`, and `import()`. */
export const ASSET_BASE = `${CLIENT_BASE}/assets`

/** Panel identity: the sidebar cell key and the main-slot key are the same word. */
export const PANEL_ID = 'excalidraw'

/** The session-scoped child slot the AI column renders through. */
export const CHAT_SLOT = 'excalidraw.chat.conversation'

/** Position among global panel icons (mainline 85, dsh-term 86). */
export const PANEL_ORDER = 84

/** Locale namespace owned by this package. */
export const LOCALE_NS = 'dsh-excalidraw'

/** Board directory names. Deliberately narrow: they become path segments. */
export const BOARD_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Hard bounds. A board is a drawing, not a database. */
export const LIMITS = Object.freeze({
  /** Elements accepted in one committed scene. */
  elements: 5000,
  /** Ops accepted in one transaction. */
  ops: 256,
  /** Ids one lock/unlock op may name. */
  ids: 256,
  /** Characters of any text value written by the agent. */
  text: 4000,
})

/** Every op the protocol understands. */
export const OP_KINDS = Object.freeze(['create', 'patch', 'delete', 'lock', 'unlock'])

/** Element fields `patch` may set. Anything else is refused, not silently dropped. */
export const PATCHABLE = Object.freeze([
  'x',
  'y',
  'width',
  'height',
  'angle',
  'text',
  'fontSize',
  'fontFamily',
  'textAlign',
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
  'link',
])

/** Element types `create` accepts directly (others arrive through Excalidraw itself). */
export const CREATABLE = Object.freeze([
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'frame',
])

/** Scene keys the Host persists from a committed scene. */
export const SCENE_KEYS = Object.freeze(['viewBackgroundColor', 'gridSize', 'gridStep', 'gridModeEnabled'])

/** An op names element ids; the union is what a transaction leases and the panel locks. */
export function targetsOf(ops) {
  const ids = new Set()
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue
    if (typeof op.id === 'string') ids.add(op.id)
    if (op.element && typeof op.element.id === 'string') ids.add(op.element.id)
    if (Array.isArray(op.ids)) {
      for (const id of op.ids) if (typeof id === 'string') ids.add(id)
    }
  }
  return [...ids]
}

/** Whether a board name may become a directory. */
export function isBoardId(value) {
  return typeof value === 'string' && BOARD_PATTERN.test(value)
}

/** Trim one agent-authored string to the protocol bound. */
export function clampText(value, limit = LIMITS.text) {
  if (typeof value !== 'string') return ''
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** The compact one-line form used by event rows and tool output. */
export function oneLine(value, limit = 160) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}
