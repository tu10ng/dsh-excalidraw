/**
 * The event rail: every session event the Host forwards, newest last.
 *
 * A row is a drag source. Dropping it on the board creates an element bound to
 * that event; the row's own button does the same at the center of the view for
 * people who would rather not drag.
 *
 * @module dsh-excalidraw/client/rail
 */

const DRAG_TYPE = 'application/x-dsh-event'

function relativeTime(at, lang) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 5) return lang === 'zh' ? '刚刚' : 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}

export function createRail({ React }) {
  const { useEffect, useRef, useState } = React
  const h = React.createElement

  return function Rail({ events, t, lang, follow, onAdd, onLocate, onOpen }) {
    const [showMinor, setShowMinor] = useState(false)
    const listRef = useRef(null)
    const visible = showMinor ? events : events.filter((event) => event.minor !== true)

    useEffect(() => {
      if (!follow || listRef.current === null) return
      listRef.current.scrollTop = listRef.current.scrollHeight
    }, [events.length, follow])

    const rows = visible.map((event) =>
      h(
        'li',
        {
          key: event.cursor,
          className: 'dsh-xr-row',
          'data-failed': event.failed === true ? '1' : '0',
          'data-minor': event.minor === true ? '1' : '0',
          draggable: true,
          onDragStart: (input) => {
            input.dataTransfer.setData(DRAG_TYPE, JSON.stringify(event))
            input.dataTransfer.effectAllowed = 'copy'
          },
          title: event.summary,
        },
        h('span', { className: 'dsh-xr-dot', 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'dsh-xr-main' },
          h(
            'div',
            { className: 'dsh-xr-line' },
            h('span', { className: 'dsh-xr-label' }, event.tool ? `${event.label} · ${event.tool}` : event.label),
            h('span', { className: 'dsh-xr-time' }, relativeTime(event.at, lang)),
          ),
          h('p', { className: 'dsh-xr-summary' }, event.summary || event.type),
          h(
            'div',
            { className: 'dsh-xr-meta' },
            h('code', null, String(event.sessionId ?? '').slice(0, 8)),
            event.seq ? h('span', null, `#${event.seq}`) : null,
            event.failed ? h('span', { className: 'dsh-xr-bad' }, t('rail.failed')) : null,
          ),
        ),
        h(
          'div',
          { className: 'dsh-xr-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-xc-icon',
              title: t('rail.add'),
              'aria-label': t('rail.add'),
              onClick: () => onAdd?.(event),
            },
            h('span', { 'aria-hidden': 'true' }, '＋'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-xc-icon',
              title: t('rail.locate'),
              'aria-label': t('rail.locate'),
              onClick: () => onLocate?.(event),
            },
            h('span', { 'aria-hidden': 'true' }, '◎'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-xc-icon',
              title: t('rail.open'),
              'aria-label': t('rail.open'),
              onClick: () => onOpen?.(event.sessionId),
            },
            h('span', { 'aria-hidden': 'true' }, '↗'),
          ),
        ),
      ),
    )

    return h(
      'aside',
      { className: 'dsh-xr', 'aria-label': t('rail.title') },
      h(
        'div',
        { className: 'dsh-xr-head' },
        h('b', null, t('rail.title')),
        h('span', { className: 'dsh-xc-grow' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-xc-chip',
            'aria-pressed': showMinor,
            onClick: () => setShowMinor((value) => !value),
          },
          showMinor ? t('rail.minorHide') : t('rail.minor'),
        ),
      ),
      h(
        'ul',
        { className: 'dsh-xr-list', ref: listRef },
        rows.length === 0
          ? h('li', { className: 'dsh-xr-empty' }, t('rail.empty'))
          : rows,
      ),
    )
  }
}
