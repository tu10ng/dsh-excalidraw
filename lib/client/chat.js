/**
 * The AI column: the board's own native conversation.
 *
 * It is the same embedding 工作树 uses — retain the session, mount the Host's
 * `SessionProvider`, render the child slot, and let the conversation feature
 * draw the transcript, the composer, and the tool cards. Nothing here
 * reimplements chat.
 *
 * @module dsh-excalidraw/client/chat
 */

import { CHAT_SLOT } from '../shared/protocol.js'

/** Deliberately the source string 工作树 uses, so retain counts read the same way. */
const RETAIN_SOURCE = 'excalidrawChat'

export function createChatPane({ React }) {
  const { useEffect, useState } = React
  const h = React.createElement

  /**
   * Retain the session for as long as this panel is mounted and hand it to the
   * session-scoped child slot. Without the standard props (a lean Host) the
   * fallback shows instead.
   */
  function ChatEmbed({ ctx, sessionId, SessionProvider, renderSlot, fallback }) {
    const [reference, setReference] = useState(null)
    const [failure, setFailure] = useState(null)

    useEffect(() => {
      if (typeof SessionProvider !== 'function' || typeof renderSlot !== 'function') return undefined
      if (typeof ctx?.sessions?.retain !== 'function') return undefined
      let hold
      try {
        hold = ctx.sessions.retain(sessionId, { source: RETAIN_SOURCE })
      } catch (error) {
        setFailure(error)
        return undefined
      }
      setReference(hold)
      setFailure(null)
      return () => {
        setReference(null)
        try {
          hold.release()
        } catch {
          /* a dead reference must not take the panel with it */
        }
      }
    }, [ctx, sessionId, SessionProvider, renderSlot])

    if (failure !== null) return fallback(failure)
    if (reference === null) return fallback(undefined)
    return h('div', { className: 'dsh-xchat-embed' }, h(SessionProvider, { session: reference }, renderSlot(CHAT_SLOT, { fallback: fallback(undefined) })))
  }

  return function ChatPane({ t, ctx, sessionId, loading, failure, SessionProvider, renderSlot, onReset }) {
    const canEmbed = typeof SessionProvider === 'function' && typeof renderSlot === 'function'
    let body
    if (failure !== null) {
      body = h('div', { className: 'dsh-xchat-note', role: 'alert' }, t('chat.error', { message: failure.message ?? String(failure) }))
    } else if (canEmbed === false) {
      body = h('div', { className: 'dsh-xchat-note' }, t('chat.unavailable'))
    } else if (loading || sessionId === null) {
      body = h('div', { className: 'dsh-xchat-note' }, t('chat.loading'))
    } else {
      body = h(ChatEmbed, {
        ctx,
        sessionId,
        SessionProvider,
        renderSlot,
        fallback: (error) =>
          h('div', { className: 'dsh-xchat-note' }, error === undefined ? t('chat.connecting') : t('chat.error', { message: error.message ?? String(error) })),
      })
    }

    return h(
      'div',
      { className: 'dsh-xchat', 'aria-label': t('chat.title') },
      h(
        'div',
        { className: 'dsh-xchat-head' },
        h('b', null, t('chat.title')),
        sessionId === null ? null : h('code', null, `#${String(sessionId).slice(-6)}`),
        h('span', { className: 'dsh-xc-grow' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-xc-chip',
            title: t('chat.resetHint'),
            disabled: sessionId === null,
            onClick: () => onReset?.(),
          },
          t('chat.reset'),
        ),
      ),
      h('div', { className: 'dsh-xchat-body' }, body),
    )
  }
}
