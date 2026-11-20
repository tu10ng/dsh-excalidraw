#!/usr/bin/env node
/**
 * Static checks, run before the test suite.
 *
 * They encode the rules that a JavaScript project cannot express: the client
 * half is a classic script, the shared protocol has no imports, the browser
 * half never touches Node, the panel only names theme tokens that exist, and
 * the two copies of the panel id agree. A failure here is a bug, not a style
 * opinion.
 */

import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.vendor', 'vendor', '.git', 'test'])
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.css', '.svg'])

/** Theme tokens the Host documents; anything else is an invented variable. */
const TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

const failures = []
const fail = (message) => failures.push(message)

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

const files = await walk(ROOT)
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')
const read = (file) => readFile(file, 'utf8')

for (const file of files.filter((name) => /\.(m?js)$/.test(name))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) fail(`${rel(file)}: syntax error\n${result.stderr.trim()}`)
}

for (const file of files.filter((name) => name.endsWith('.json'))) {
  try {
    JSON.parse(await read(file))
  } catch (error) {
    fail(`${rel(file)}: invalid JSON (${error.message})`)
  }
}

const pkg = JSON.parse(await read(path.join(ROOT, 'package.json')))
const index = await read(path.join(ROOT, 'lib', 'index.js'))
const client = await read(path.join(ROOT, 'lib', 'client.js'))
const protocol = await read(path.join(ROOT, 'lib', 'shared', 'protocol.js'))
const css = await read(path.join(ROOT, 'lib', 'client', 'panel.css'))
const loader = await read(path.join(ROOT, 'lib', 'client', 'vendor-loader.js'))
const vendorManifest = JSON.parse(await read(path.join(ROOT, 'lib', 'vendor', 'manifest.json')))

const versionOf = (text) => /export const VERSION = '([^']+)'/.exec(text)?.[1]
const clientVersion = /const VERSION = '([^']+)'/.exec(client)?.[1]
if (versionOf(index) !== pkg.version) fail(`lib/index.js VERSION (${versionOf(index)}) !== package.json (${pkg.version})`)
if (clientVersion !== pkg.version) fail(`lib/client.js VERSION (${clientVersion}) !== package.json (${pkg.version})`)
if (vendorManifest.excalidraw !== /VENDOR_REV = '([^']+)'/.exec(loader)?.[1]) {
  fail('lib/client/vendor-loader.js VENDOR_REV does not match lib/vendor/manifest.json')
}

const panelId = /export const PANEL_ID = '([^']+)'/.exec(protocol)?.[1]
const order = /export const PANEL_ORDER = (\d+)/.exec(protocol)?.[1]
const chatSlot = /export const CHAT_SLOT = '([^']+)'/.exec(protocol)?.[1]
if (panelId === undefined || !protocol.includes('PANEL_ID')) fail('lib/shared/protocol.js: PANEL_ID missing')
if (!client.includes(`const PANEL_ID = '${panelId}'`)) fail('lib/client.js PANEL_ID does not match the shared protocol')
if (!client.includes(`const PANEL_ORDER = ${order}`)) fail('lib/client.js PANEL_ORDER does not match the shared protocol')
if (chatSlot === undefined || !client.includes(`const CHAT_SLOT = '${chatSlot}'`)) {
  fail('lib/client.js CHAT_SLOT does not match the shared protocol')
}

if (/^\s*import\s/m.test(client) || /^\s*export\s/m.test(client)) fail('lib/client.js must stay a classic script (no top-level import/export)')
if (!client.includes('__ModuleLoader__.load')) fail('lib/client.js must register through __ModuleLoader__.load')
if (/require\(['"]@deepseek-ai\//.test(client)) fail('lib/client.js must not require a Harness client package')

for (const file of files.filter((name) => rel(name).startsWith('lib/'))) {
  const text = await read(file)
  if (/@deepseek-ai\//.test(text) && !rel(file).endsWith('README.md')) {
    fail(`${rel(file)}: imports a Harness package directly`)
  }
}

const shared = await read(path.join(ROOT, 'lib', 'shared', 'protocol.js'))
if (/^\s*import\s/m.test(shared)) fail('lib/shared/protocol.js must have no imports (it is served to the browser)')

for (const file of files.filter((name) => rel(name).startsWith('lib/client/'))) {
  const text = await read(file)
  if (/from ['"]node:/.test(text) || /require\(['"]node:/.test(text)) fail(`${rel(file)}: browser code imports a Node builtin`)
}

/** Panel chrome may only name tokens the Host documents. */
const cssBody = css.replace(/\/\*[\s\S]*?\*\//g, '')
for (const token of cssBody.match(/--dsw-[a-z0-9-]+/g) ?? []) {
  if (!TOKENS.has(token)) fail(`lib/client/panel.css: unknown theme token ${token}`)
}

const vendorBytes = (await stat(path.join(ROOT, 'lib', 'vendor', 'excalidraw.js'))).size
if (vendorBytes < 1_000_000) fail('lib/vendor/excalidraw.js looks truncated; run npm run build:vendor')
if (!(await readFile(path.join(ROOT, 'lib', 'vendor', 'excalidraw.js'), 'utf8')).includes('window.__DSH_EXCALIDRAW__')) {
  fail('lib/vendor/excalidraw.js is not wrapped for the panel loader')
}

for (const file of files.filter((name) => TEXT.has(path.extname(name)))) {
  const text = await read(file)
  if (/[A-Za-z]:\\Users\\/.test(text)) fail(`${rel(file)}: contains a machine-local path`)
}

if (failures.length > 0) {
  for (const message of failures) console.error(`✖ ${message}`)
  process.exitCode = 1
} else {
  console.log(`✔ ${files.length} files checked`)
}
