/**
 * dsh-excalidraw — Client half (classic script).
 *
 * This file is deliberately thin: it registers the sidebar cell and the main
 * panel, then imports the real panel the first time the panel renders. The
 * panel, its styles, and the Excalidraw vendor bundle are all served by the
 * plugin's own asset route, so nothing here is downloaded until someone opens
 * the board.
 *
 * Everything else lives in ES modules under `client/`, which keeps the heavy
 * board logic out of the module-loader factory.
 *
 * @module dsh-excalidraw/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-excalidraw',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Keep in sync with `lib/shared/protocol.js`; `scripts/check.mjs` asserts it.
    const PANEL_ID = 'excalidraw'
    const CHAT_SLOT = 'excalidraw.chat.conversation'
    const PANEL_ORDER = 84
    const LOCALE_NS = 'dsh-excalidraw'
    const ASSET = 'api/excalidraw/assets'
    const VERSION = '0.1.0'

    /** Only the shell strings live here; the panel owns its own dictionary. */
    const SHELL = {
      zh: {
        'entry.label': '画板',
        'view.loading': '正在加载画板…',
        'view.loadFailed': '画板加载失败：{message}',
        'boundary.error': '面板出错了：{message}',
        'action.retry': '重试',
      },
      en: {
        'entry.label': 'Canvas',
        'view.loading': 'Loading the board…',
        'view.loadFailed': 'The board failed to load: {message}',
        'boundary.error': 'The panel failed: {message}',
        'action.retry': 'Retry',
      },
    }

    function resolveLang(ctx) {
      try {
        const snapshot = ctx?.locale?.getLocale?.() ?? ctx?.locale?.getSnapshot?.()
        const id = snapshot?.active ?? snapshot?.id ?? snapshot?.locale ?? 'en'
        return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    function translate(lang, key, vars) {
      const dict = SHELL[lang] ?? SHELL.en
      const template = dict[key] ?? SHELL.en[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
    }

    /** A crashing panel must never blank its slot for the rest of the session. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = () => this.setState({ error: null })
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-excalidraw] 面板渲染出错', error)
        } catch {
          /* logging must never throw */
        }
      }

      render() {
        const lang = resolveLang(this.props.ctx)
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'dsh-xc-state dsh-xc-state-error', role: 'alert' },
            h('p', null, translate(lang, 'boundary.error', { message: this.state.error?.message ?? String(this.state.error) })),
            h('button', { type: 'button', className: 'dsh-xc-btn', onClick: this.retry }, translate(lang, 'action.retry')),
          )
        }
        return h(this.props.component, this.props.componentProps)
      }
    }

    /**
     * Lazy door to the real panel: the module is fetched on first render, and a
     * failed fetch is retryable without remounting the whole application.
     */
    function PanelHost(props) {
      const { ctx } = props
      const lang = resolveLang(ctx)
      const t = (key, vars) => translate(lang, key, vars)
      const [attempt, setAttempt] = React.useState(0)
      const [state, setState] = React.useState({ module: null, error: null })

      React.useEffect(() => {
        let live = true
        setState({ module: null, error: null })
        // `import()` needs an absolute URL: a bare `api/...` path has no scheme
        // and is not a valid module specifier.
        const panelUrl = new URL(`${ASSET}/client/panel.js?v=${VERSION}`, document.baseURI).href
        import(panelUrl)
          .then((module) => {
            if (live) setState({ module, error: null })
          })
          .catch((error) => {
            if (live) setState({ module: null, error })
          })
        return () => {
          live = false
        }
      }, [attempt])

      const Panel = React.useMemo(
        () => (state.module === null ? null : state.module.createPanel({ React, require: props.require, ctx })),
        [state.module, ctx, props.require],
      )

      if (state.error !== null) {
        return h(
          'div',
          { className: 'dsh-xc-state dsh-xc-state-error', role: 'alert' },
          h('p', null, t('view.loadFailed', { message: state.error?.message ?? String(state.error) })),
          h('button', { type: 'button', className: 'dsh-xc-btn', onClick: () => setAttempt((value) => value + 1) }, t('action.retry')),
        )
      }

      if (Panel === null) {
        return h(
          'div',
          { className: 'dsh-xc-state' },
          h('div', { className: 'dsh-xc-spinner', 'aria-hidden': 'true' }),
          h('p', null, t('view.loading')),
        )
      }

      return h(Panel, props)
    }

    /** A rounded frame with one stroke and two handles: the board, at 16px. */
    function Glyph({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('rect', { x: 3.2, y: 3.2, width: 17.6, height: 17.6, rx: 3.2, opacity: 0.55 }),
        h('path', { d: 'M7.6 16.4 16.4 7.6' }),
        h('circle', { cx: 7.6, cy: 7.6, r: 1.5 }),
        h('circle', { cx: 16.4, cy: 16.4, r: 1.5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /** Keep the embedded conversation on the transcript of this one session. */
    function PinnedChatView(props) {
      return h(
        React.Fragment,
        null,
        typeof props.renderSlot === 'function' ? props.renderSlot('conversation.session', { view: 'chat' }) : null,
      )
    }

    /**
     * The board's conversation, rendered the way 工作树 renders its own: the
     * Host's `conversation.content` factory draws the transcript and composer
     * inside the session-scoped child slot above.
     */
    function ChatConversation(props) {
      let phase = 'active'
      let hero = false
      try {
        const session = typeof props.useSession === 'function' ? props.useSession((value) => value) : null
        const hasTurns = session?.blank !== true && session?.awaitingFirstTurn !== true
        const blank = session?.running !== true && !hasTurns && session?.promptAttempted !== true
        if (blank === true) {
          const settling = session?.openState === 'loading'
          phase = settling ? 'settling' : 'hero'
          hero = !settling
        }
      } catch {
        /* a snapshot that cannot be read still deserves a room */
      }
      if (typeof props.renderFactorySlot !== 'function') return props.fallback ?? null
      return props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase, hero },
        { slots: { views: PinnedChatView }, fallback: props.fallback },
      )
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, SHELL), `${LOCALE_NS}: dictionaries`)

        // Assets this panel injects belong to the plugin, not to the document.
        ctx.effect(
          () => () => {
            for (const node of document.querySelectorAll('[data-dsh-excalidraw]')) node.parentNode?.removeChild(node)
            delete window.__DSH_EXCALIDRAW__
            delete window.__DSH_EXCALIDRAW_REQUIRE__
          },
          `${LOCALE_NS}: assets`,
        )

        const Bounded = (props) =>
          h(PanelBoundary, {
            ctx,
            component: PanelHost,
            componentProps: { ...props, ctx, require },
          })

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => translate(resolveLang(ctx), 'entry.label'),
              locale: LOCALE_NS,
            },
            Glyph,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: LOCALE_NS,
              // The session-scoped child is what mints `SessionProvider` and the
              // child `renderSlot` for the AI column.
              children: { [CHAT_SLOT]: { kind: 'single', scope: 'session' } },
            },
            Bounded,
          ),
        )

        // Registered on its own: `slots.inject` fires once the child declaration above exists.
        ctx.slots.inject(CHAT_SLOT, () => ctx.slots.register({ name: CHAT_SLOT }, ChatConversation))
      },
    }
  },
})
