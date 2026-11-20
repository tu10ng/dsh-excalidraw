/**
 * Static assets: the panel's ES modules, the built Excalidraw vendor bundle, its
 * stylesheet, and the fonts that stylesheet asks for.
 *
 * Everything is read from this package's own `lib/` directory. Only four
 * subdirectories are reachable, and the resolved path must stay inside one of
 * them — the asset route is the one HTTP surface a browser can aim anywhere.
 *
 * @module dsh-excalidraw/assets
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const TYPES = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
})

/** Directories the route may serve from, relative to `lib/`. */
const REACHABLE = Object.freeze(['client', 'shared', 'vendor', 'locale'])

/**
 * Resolve a request path suffix such as `client/panel.js` to a file inside the
 * package, or `null` when it is not a declared, safe asset.
 *
 * @param {string} libRoot absolute path of this package's `lib/`
 * @param {string} suffix request path after the asset route prefix
 */
export function resolveAsset(libRoot, suffix) {
  const decoded = safeDecode(suffix)
  if (decoded === null) return null
  const cleaned = decoded.replace(/^\/+/, '')
  if (cleaned === '' || cleaned.includes('\0')) return null
  const [top] = cleaned.split('/')
  if (!REACHABLE.includes(top)) return null
  const target = path.resolve(libRoot, cleaned)
  const guard = path.resolve(libRoot, top) + path.sep
  if (!target.startsWith(guard)) return null
  return target
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** Media type for one asset path; unknown extensions are refused, not guessed. */
export function assetType(file) {
  return TYPES[path.extname(file).toLowerCase()] ?? null
}

/** One `vendor/` read per process: the bundle never changes while the Host runs. */
const vendorCache = new Map()

/**
 * Read an asset for an HTTP response.
 *
 * @returns {Promise<{ body: Buffer, type: string, cache: string } | null>}
 */
export async function readAsset(file) {
  const type = assetType(file)
  if (type === null) return null
  const immutable = file.includes(`${path.sep}vendor${path.sep}`)
  if (immutable) {
    const cached = vendorCache.get(file)
    if (cached !== undefined) return { body: cached, type, cache: 'public, max-age=31536000, immutable' }
  }
  try {
    const body = await readFile(file)
    if (immutable) vendorCache.set(file, body)
    return { body, type, cache: immutable ? 'public, max-age=31536000, immutable' : 'no-store' }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return null
    throw error
  }
}
