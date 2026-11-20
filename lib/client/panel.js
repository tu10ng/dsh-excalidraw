/**
 * The panel: header, canvas, and one right-hand column that holds either the
 * board's own AI conversation or the session event rail.
 *
 * The AI column is the point: it embeds the Host's real conversation — the same
 * one 工作树 puts beside its tree — so the assistant can see the board, call the
 * board tools, and answer in place while the person keeps drawing.
 *
 * @module dsh-excalidraw/client/panel
 */

import { createBoardApi } from './api.js'
import { bindingOf } from './board-ops.js'
import { createCanvas } from './canvas.js'
import { createChatPane } from './chat.js'
import { resolveLang, translator } from './i18n.js'
import { createRail } from './rail.js'
import { ensureStyle } from './vendor-loader.js'
import { ASSET_BASE } from '../shared/protocol.js'

const MAX_EVENTS = 500
const TOAST_MS = 3_200
const SIDE_KEY = 'dsh-excalidraw:side'
const SIDE_DEFAULT = { width: 392, open: true, tab: 'chat' }
const SIDE_MIN = 300
const SIDE_MAX = 680

/** Sidebar preference survives a panel remount; a broken value falls back. */
function readSide() {
  try {
    const raw = localStorage.getItem(SIDE_KEY)
    if (raw === null) return SIDE_DEFAULT
    const parsed = JSON.parse(raw)
    return {
      width: clampWidth(parsed?.width),
      open: parsed?.open !== false,
      tab: parsed?.tab === 'events' ? 'events' : 'chat',
    }
  } catch {
    return SIDE_DEFAULT
  }
}

function clampWidth(value) {
  if (!Number.isFinite(value)) return SIDE_DEFAULT.width
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(value)))
}

export function createPanel({ React, require, ctx }) {
  const { useCallback, useEffect, useRef, useState } = React
  const h = React.createElement

  ensureStyle(`${ASSET_BASE}/client/panel.css`, 'panel')

  const api = createBoardApi()
  const Canvas = createCanvas({ React, api })
  const Rail = createRail({ React })
  const ChatPane = createChatPane({ React })

  /** Locale changes re-render this panel's own copy. */
  function useLang() {
    const [lang, setLang] = useState(() => resolveLang(ctx))
    useEffect(() => {
      let off
      try {
        off = ctx?.locale?.subscribe?.(() => setLang(resolveLang(ctx)))
      } catch {
        off = undefined
      }
      return () => {
        try {
          off?.()
        } catch {
          /* a dead subscription must not take the panel with it */
        }
      }
    }, [])
    return lang
  }

  /** The board follows the application's light/dark choice. */
  function useColorScheme() {
    const read = () => {
      try {
        // `theme` is optional for this panel: a lean host may not provide it.
        return ctx?.get?.('theme')?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light'
      } catch {
        return 'light'
      }
    }
    const [scheme, setScheme] = useState(read)
    useEffect(() => {
      let off
      try {
        off = ctx?.on?.('theme/change', () => setScheme(read()))
      } catch {
        off = undefined
      }
      return () => {
        try {
          off?.()
        } catch {
          /* theme is cosmetic; never throw on teardown */
        }
      }
    }, [])
    return scheme
  }

  return function Panel(slotProps) {
    const lang = useLang()
    const colorScheme = useColorScheme()
    const t = translator(lang)

    const [events, setEvents] = useState([])
    const [status, setStatus] = useState({ rev: 0, leases: [], connected: false, empty: true })
    const [follow, setFollow] = useState(false)
    const [selection, setSelection] = useState([])
    const [toast, setToast] = useState(null)
    const [retryKey, setRetryKey] = useState(0)
    const [side, setSide] = useState(readSide)
    const [unread, setUnread] = useState(0)
    const [chat, setChat] = useState({ id: null, loading: true, error: null })

    const canvasRef = useRef(null)
    const toastTimer = useRef(0)
    const sideRef = useRef(side)
    sideRef.current = side

    const showToast = useCallback((message) => {
      setToast(message)
      clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
    }, [])

    useEffect(() => () => clearTimeout(toastTimer.current), [])

    // Persist the sidebar after the drag settles, not on every pointer move.
    useEffect(() => {
      const timer = setTimeout(() => {
        try {
          localStorage.setItem(SIDE_KEY, JSON.stringify(side))
        } catch {
          /* storage may be disabled; the panel still works */
        }
      }, 200)
      return () => clearTimeout(timer)
    }, [side])

    // The board's conversation exists as soon as it is asked for.
    useEffect(() => {
      let live = true
      api
        .chat()
        .then((payload) => {
          if (live) setChat({ id: payload.sessionId, loading: false, error: null })
        })
        .catch((error) => {
          if (live) setChat({ id: null, loading: false, error })
        })
      return () => {
        live = false
      }
    }, [])

    const resetChat = useCallback(() => {
      api
        .resetChat()
        .then((payload) => setChat({ id: payload.sessionId, loading: false, error: null }))
        .catch((error) => showToast(t('chat.error', { message: error.message })))
    }, [showToast, t])

    const onEvent = useCallback((record) => {
      setEvents((previous) => {
        const next = previous.length >= MAX_EVENTS ? previous.slice(-(MAX_EVENTS - 1)) : previous.slice()
        next.push(record)
        return next
      })
      if (sideRef.current.tab !== 'events') setUnread((count) => count + 1)
    }, [])

    const onEvents = useCallback((seed) => {
      if (!Array.isArray(seed) || seed.length === 0) return
      setEvents((previous) => (previous.length > 0 ? previous : seed.slice(-MAX_EVENTS)))
    }, [])

    const onAdd = useCallback(
      (record) => {
        if (canvasRef.current === null) return
        if (canvasRef.current.addEvent(record) !== false) showToast(t('action.addAtCenter'))
      },
      [showToast, t],
    )

    const onLocate = useCallback(
      (record) => {
        if (canvasRef.current === null) return
        const found = canvasRef.current.locate(bindingOf(record), { scroll: true })
        if (found === 0) showToast(t('rail.notOnBoard'))
      },
      [showToast, t],
    )

    const onOpen = useCallback(
      (sessionId) => {
        try {
          ctx?.uiWorkspace?.openSession?.(sessionId)
        } catch (error) {
          showToast(String(error?.message ?? error))
        }
      },
      [ctx, showToast],
    )

    const selectTab = useCallback((tab) => {
      setSide((current) => ({ ...current, tab }))
      if (tab === 'events') setUnread(0)
    }, [])

    /** Drag the splitter; the canvas takes the rest of the width. */
    const beginSideDrag = useCallback((input) => {
      input.preventDefault()
      const startX = input.clientX
      const startWidth = sideRef.current.width
      const move = (event) => {
        const width = clampWidth(startWidth - (event.clientX - startX))
        setSide((current) => ({ ...current, width }))
      }
      const stop = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
    }, [])

    const held = Array.isArray(status.leases) ? status.leases.length : 0
    const bound = selection.find((item) => Array.isArray(item.binding) && item.binding.length > 0)
    const latestBinding = bound?.binding.at(-1)

    return h(
      'div',
      { className: 'dsh-xc-root' },
      h(
        'header',
        { className: 'dsh-xc-head' },
        h('span', { className: 'dsh-xc-eyebrow', 'aria-hidden': 'true' }, 'EXCALIDRAW'),
        h('b', { className: 'dsh-xc-name' }, t('panel.title')),
        h(
          'span',
          {
            className: 'dsh-xc-live',
            'data-on': status.connected ? '1' : '0',
            title: status.connected ? t('panel.live') : t('panel.offline'),
            'aria-label': status.connected ? t('panel.live') : t('panel.offline'),
          },
          '●',
        ),
        h('span', { className: 'dsh-xc-rev' }, t('panel.rev', { rev: status.rev })),
        held > 0
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-xc-held',
                title: t('panel.release'),
                onClick: () => canvasRef.current?.takeBack(),
              },
              t('panel.held', { count: held }),
              h('span', { className: 'dsh-xc-held-action' }, t('panel.release')),
            )
          : null,
        h('span', { className: 'dsh-xc-grow' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-xc-chip',
            'aria-pressed': follow,
            title: t('panel.follow'),
            onClick: () => setFollow((value) => !value),
          },
          follow ? t('panel.followOn') : t('panel.follow'),
        ),
        h('button', { type: 'button', className: 'dsh-xc-chip', onClick: () => canvasRef.current?.fit() }, t('panel.fit')),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-xc-chip',
            'aria-pressed': side.open,
            title: side.open ? t('panel.sideHide') : t('panel.sideShow'),
            onClick: () => setSide((current) => ({ ...current, open: !current.open })),
          },
          side.open ? t('panel.sideHide') : t('panel.sideShow'),
        ),
      ),
      h(
        'div',
        {
          className: 'dsh-xc-body',
          'data-side': side.open ? '1' : '0',
          style: side.open ? { gridTemplateColumns: `minmax(0, 1fr) 7px ${side.width}px` } : undefined,
        },
        h(
          'div',
          { className: 'dsh-xc-canvas' },
          h(Canvas, {
            require,
            t,
            lang,
            colorScheme,
            follow,
            retryKey,
            canvasRef,
            onEvent,
            onEvents,
            onStatus: setStatus,
            onSelection: setSelection,
            onToast: showToast,
            onRetry: () => setRetryKey((value) => value + 1),
          }),
          bound !== undefined && latestBinding !== undefined
            ? h(
                'div',
                { className: 'dsh-xc-inspector' },
                h('b', null, t('binding.title')),
                h(
                  'span',
                  { className: 'dsh-xc-inspector-state' },
                  `${bound.type} · ${String(latestBinding.sessionId).slice(0, 8)}#${latestBinding.seq}`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-xc-chip',
                    onClick: () =>
                      canvasRef.current?.locate(
                        { sessionId: latestBinding.sessionId, seq: latestBinding.seq },
                        { scroll: true },
                      ),
                  },
                  t('binding.locate'),
                ),
                h('button', { type: 'button', className: 'dsh-xc-chip', onClick: () => onOpen(latestBinding.sessionId) }, t('binding.open')),
              )
            : null,
          toast !== null ? h('div', { className: 'dsh-xc-toast', role: 'status' }, toast) : null,
        ),
        side.open
          ? h('div', {
              className: 'dsh-xc-split',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': t('side.split'),
              tabIndex: 0,
              onPointerDown: beginSideDrag,
              onDoubleClick: () => setSide((current) => ({ ...current, width: SIDE_DEFAULT.width })),
              onKeyDown: (event) => {
                if (event.key === 'ArrowLeft') setSide((current) => ({ ...current, width: clampWidth(current.width + 24) }))
                else if (event.key === 'ArrowRight') setSide((current) => ({ ...current, width: clampWidth(current.width - 24) }))
                else return
                event.preventDefault()
              },
            })
          : null,
        side.open
          ? h(
              'aside',
              { className: 'dsh-xc-side' },
              h(
                'div',
                { className: 'dsh-xc-tabs', role: 'tablist' },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'dsh-xc-tab',
                    'aria-selected': side.tab === 'chat',
                    onClick: () => selectTab('chat'),
                  },
                  t('side.chat'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'dsh-xc-tab',
                    'aria-selected': side.tab === 'events',
                    onClick: () => selectTab('events'),
                  },
                  t('side.events'),
                  unread > 0 && side.tab !== 'events' ? h('span', { className: 'dsh-xc-badge' }, unread > 99 ? '99+' : String(unread)) : null,
                ),
                h('span', { className: 'dsh-xc-grow' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-xc-icon',
                    title: t('side.collapse'),
                    'aria-label': t('side.collapse'),
                    onClick: () => setSide((current) => ({ ...current, open: false })),
                  },
                  '⟩',
                ),
              ),
              side.tab === 'chat'
                ? h(ChatPane, {
                    t,
                    ctx,
                    sessionId: chat.id,
                    loading: chat.loading,
                    failure: chat.error,
                    SessionProvider: slotProps.SessionProvider,
                    renderSlot: slotProps.renderSlot,
                    onReset: resetChat,
                  })
                : h(Rail, { events, t, lang, follow, onAdd, onLocate, onOpen }),
            )
          : null,
      ),
    )
  }
}
