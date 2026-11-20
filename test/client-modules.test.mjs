import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The panel is plain ES modules with no React import of their own: React comes
 * from the page. Importing them here catches the one failure a browser would
 * show as a blank panel — a module that does not resolve or a top-level
 * reference to something only a browser has.
 */

const MODULES = [
  '../lib/shared/protocol.js',
  '../lib/client/i18n.js',
  '../lib/client/api.js',
  '../lib/client/board-ops.js',
  '../lib/client/vendor-loader.js',
  '../lib/client/rail.js',
  '../lib/client/chat.js',
  '../lib/client/canvas.js',
  '../lib/client/panel.js',
]

test('every client module imports without a browser', async () => {
  for (const specifier of MODULES) {
    const loaded = await import(specifier)
    assert.ok(Object.keys(loaded).length > 0, `${specifier} has no exports`)
  }
})

test('the panel factory composes without touching the DOM', async () => {
  const { createPanel } = await import('../lib/client/panel.js')
  const noop = () => {}
  const React = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const Panel = createPanel({ React, require: () => ({}), ctx: {} })
  assert.equal(typeof Panel, 'function')
})

test('the translator falls back to English for an unknown key', async () => {
  const { translator, resolveLang } = await import('../lib/client/i18n.js')
  assert.equal(translator('zh')('panel.title'), '画板')
  assert.equal(translator('en')('panel.title'), 'Canvas')
  assert.equal(translator('en')('missing.key'), 'missing.key')
  assert.equal(resolveLang({ locale: { getLocale: () => ({ active: 'zh-CN' }) } }), 'zh')
  assert.equal(resolveLang({}), 'en')
})
