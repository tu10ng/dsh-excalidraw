import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { assetType, resolveAsset } from '../lib/assets.js'

const LIB = path.resolve('lib')

test('a declared asset resolves inside its own directory', () => {
  const file = resolveAsset(LIB, 'client/panel.js')
  assert.equal(file, path.join(LIB, 'client', 'panel.js'))
})

test('the browser may not climb out of a reachable directory', () => {
  assert.equal(resolveAsset(LIB, '../index.js'), null)
  assert.equal(resolveAsset(LIB, 'client/../../index.js'), null)
  assert.equal(resolveAsset(LIB, '%2e%2e%2findex.js'), null)
  assert.equal(resolveAsset(LIB, 'client/..%2f..%2findex.js'), null)
})

test('only the four declared directories are reachable', () => {
  assert.equal(resolveAsset(LIB, 'index.js'), null)
  assert.equal(resolveAsset(LIB, 'client'), null)
  assert.equal(resolveAsset(LIB, 'scripts/build-vendor.mjs'), null)
})

test('unknown extensions are refused rather than guessed', () => {
  assert.equal(assetType('/x/y.js'), 'text/javascript; charset=utf-8')
  assert.equal(assetType('/x/y.woff2'), 'font/woff2')
  assert.equal(assetType('/x/y.exe'), null)
})
