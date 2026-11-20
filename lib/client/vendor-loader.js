/**
 * The only loader for the Excalidraw vendor bundle.
 *
 * The bundle is a classic script (CommonJS output wrapped in
 * `window.__DSH_EXCALIDRAW__(function (require) { … })`), so it needs the Host
 * page's module-table `require` before it runs. That `require` is put on the
 * window for the duration of the load and removed right after: React is shared
 * with the whole page, never duplicated.
 *
 * @module dsh-excalidraw/client/vendor-loader
 */

import { ASSET_BASE } from '../shared/protocol.js'

/** Part of the asset URL; bump with the vendored Excalidraw version. */
export const VENDOR_REV = '0.18.1'

let pending = null

/** Inject one stylesheet once per document. */
export function ensureStyle(href, owner = 'dsh-excalidraw') {
  if (typeof document === 'undefined') return () => {}
  const same = [...document.querySelectorAll(`link[data-dsh-excalidraw="${owner}"]`)].some(
    (link) => link.getAttribute('href') === href,
  )
  if (same) return () => {}
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.dshExcalidraw = owner
  document.head.appendChild(link)
  return () => link.parentNode?.removeChild(link)
}

/**
 * Load (once) and return the Excalidraw module.
 *
 * @param {(specifier: string) => unknown} require the client module-table require
 * @returns {Promise<object>}
 */
export function loadVendor(require) {
  if (typeof window !== 'undefined' && window.__DSH_EXCALIDRAW__) return Promise.resolve(window.__DSH_EXCALIDRAW__)
  if (pending !== null) return pending

  pending = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('没有浏览器环境'))
      return
    }
    ensureStyle(`${ASSET_BASE}/vendor/excalidraw.css`, 'vendor')
    window.__DSH_EXCALIDRAW_REQUIRE__ = require

    const script = document.createElement('script')
    script.src = `${ASSET_BASE}/vendor/excalidraw.js?v=${VENDOR_REV}`
    script.async = true
    script.dataset.dshExcalidraw = 'vendor'
    script.onload = () => {
      delete window.__DSH_EXCALIDRAW_REQUIRE__
      const module = window.__DSH_EXCALIDRAW__
      // `Excalidraw` is a React.memo component: an object, not a function.
      if (module && module.Excalidraw !== undefined && typeof module.convertToExcalidrawElements === 'function') {
        resolve(module)
      } else {
        reject(new Error('Excalidraw 资源已加载，但没有导出组件'))
      }
    }
    script.onerror = () => {
      delete window.__DSH_EXCALIDRAW_REQUIRE__
      reject(new Error('Excalidraw 资源加载失败'))
    }
    document.head.appendChild(script)
  })

  // A failed load must be retryable from the error card.
  pending.catch(() => {
    pending = null
  })
  return pending
}
