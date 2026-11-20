/**
 * The board component: Excalidraw plus the one thing Excalidraw cannot do by
 * itself — merge a person's live scene with an agent's transaction without
 * stealing what the person is holding.
 *
 * The rules, in order of importance:
 *
 * 1. **Unchanged elements keep their object identity.** `updateScene` swaps the
 *    array, not the elements, so a drag or a resize that started a moment ago
 *    keeps pointing at the same object.
 * 2. **An element under the hand is never replaced.** It is deferred instead,
 *    and the server restores its pre-transaction value so nothing is lost; the
 *    panel re-applies the op when the gesture ends.
 * 3. **A held element is locked and shown as another user's selection.** That is
 *    Excalidraw's own collaboration model, not a painted overlay.
 * 4. **The revision is the truth.** A write against a stale revision re-reads and
 *    retries; it never overwrites blind.
 *
 * @module dsh-excalidraw/client/canvas
 */

import {
  applyClientOp,
  bindingOf,
  bindingsOf,
  hasBinding,
  idsOfOp,
  lockOnClient,
  sceneSignature,
} from './board-ops.js'
import { loadVendor } from './vendor-loader.js'
import { SCENE_KEYS } from '../shared/protocol.js'

const STREAM = 'api/excalidraw/stream'
const SAVE_DELAY_MS = 500
const HIGHLIGHT_MS = 1_600
const MAX_SELECTION_REPORT = 40

/** What the Host persists of Excalidraw's app state; everything else is local. */
export function pickAppState(appState) {
  const picked = {}
  for (const key of SCENE_KEYS) {
    if (appState?.[key] !== undefined) picked[key] = appState[key]
  }
  return picked
}

/**
 * Build the imperative engine once per mounted panel. The component below is a
 * thin renderer over it; every callback lives here so React re-renders never
 * re-connect or re-order anything.
 */
function createEngine(deps) {
  const {
    api,
    propsRef,
    vendorRef,
    apiRef,
    hostRef,
    baseRev,
    leasesRef,
    lastApplied,
    lastSaved,
    txOpen,
    dirtyDuringTx,
    pendingMerge,
    deferredOps,
    saveTimer,
    saveChain,
    txChain,
    setRev,
    setLeases,
    setConnected,
    report,
  } = deps

  const tools = () => {
    const vendor = vendorRef.current
    return {
      convert: vendor.convertToExcalidrawElements,
      newElementWith: vendor.newElementWith,
      now: Date.now(),
    }
  }

  function scene() {
    return apiRef.current?.getSceneElementsIncludingDeleted() ?? []
  }

  function sceneMap() {
    return new Map(scene().map((element) => [element.id, element]))
  }

  function busyIds(appState) {
    const ids = new Set()
    for (const key of ['editingTextElement', 'resizingElement', 'newElement', 'multiElement', 'selectionElement']) {
      const element = appState?.[key]
      if (element?.id !== undefined) ids.add(element.id)
    }
    if (typeof appState?.editingLinearElement?.elementId === 'string') ids.add(appState.editingLinearElement.elementId)
    if (appState?.selectedElementsAreBeingDragged === true) {
      for (const id of Object.keys(appState.selectedElementIds ?? {})) ids.add(id)
    }
    return ids
  }

  function collaborators() {
    const instance = apiRef.current
    const held = leasesRef.current
    if (instance === null || held.size === 0) return new Map()
    const byId = new Map(instance.getSceneElements().map((element) => [element.id, element]))
    const selectedElementIds = {}
    let pointer = null
    for (const id of held.keys()) {
      const element = byId.get(id)
      if (element === undefined) continue
      selectedElementIds[id] = true
      pointer ??= { x: element.x + element.width / 2, y: element.y + element.height / 2, tool: 'pointer' }
    }
    if (Object.keys(selectedElementIds).length === 0) return new Map()
    return new Map([
      [
        'dsh',
        {
          username: 'DSH',
          color: { background: '#7c6cf0', stroke: '#7c6cf0' },
          selectedElementIds,
          pointer,
        },
      ],
    ])
  }

  /** One atomic scene write; the only place this component calls `updateScene`. */
  function applyScene(elements, appStatePatch) {
    const instance = apiRef.current
    if (instance === null) return
    // Excalidraw adopts this exact array, so `onChange` can recognise an echo by
    // identity instead of by a timing flag.
    lastApplied.current = elements
    instance.updateScene({
      elements,
      collaborators: collaborators(),
      captureUpdate: vendorRef.current.CaptureUpdateAction.NEVER,
      ...(appStatePatch === undefined ? {} : { appState: appStatePatch }),
    })
  }

  function setLeaseList(list) {
    leasesRef.current = new Map((list ?? []).map((lease) => [lease.id, lease]))
    setLeases([...leasesRef.current.values()])
  }

  function mergeScene(changed) {
    const instance = apiRef.current
    if (instance === null || !Array.isArray(changed) || changed.length === 0) return
    const app = instance.getAppState()
    const busy = busyIds(app)
    const remote = []
    for (const element of changed) {
      if (busy.has(element.id) && !leasesRef.current.has(element.id)) {
        pendingMerge.current.set(element.id, element)
        continue
      }
      remote.push(element)
    }
    if (remote.length === 0) return
    const local = scene()
    const merged = vendorRef.current.reconcileElements(local, remote, app)
    // A frame that resolves to the objects already on screen is not a change:
    // applying it would churn element identity for nothing.
    if (merged.length === local.length && merged.every((element, index) => element === local[index])) return
    applyScene(merged)
  }

  async function resync() {
    const state = await api.state()
    baseRev.current = state.rev
    setRev(state.rev)
    setLeaseList(state.leases)
    mergeScene(state.elements)
    return state
  }

  async function saveNow() {
    if (txOpen.current) {
      dirtyDuringTx.current = true
      return
    }
    const instance = apiRef.current
    if (instance === null) return
    const body = {
      baseRev: baseRev.current,
      elements: instance.getSceneElementsIncludingDeleted(),
      appState: pickAppState(instance.getAppState()),
      files: instance.getFiles(),
    }
    const signature = sceneSignature(body.elements)
    if (signature === lastSaved.current) return
    try {
      const saved = await api.save(body)
      lastSaved.current = signature
      accept(saved.rev)
    } catch (error) {
      if (error.code !== 'stale-revision') {
        report('panel.saveFailed', { message: error.message })
        return
      }
      report('panel.conflict')
      try {
        await resync()
        const elements = instance.getSceneElementsIncludingDeleted()
        const retried = await api.save({ ...body, baseRev: baseRev.current, elements })
        lastSaved.current = sceneSignature(elements)
        accept(retried.rev)
      } catch (second) {
        report('panel.saveFailed', { message: second.message })
      }
    }
  }

  function accept(nextRev) {
    if (!Number.isInteger(nextRev)) return
    baseRev.current = nextRev
    setRev(nextRev)
  }

  function scheduleSave() {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveChain.current = saveChain.current.then(saveNow, saveNow)
    }, SAVE_DELAY_MS)
  }

  function flushPending() {
    const pending = pendingMerge.current
    if (pending.size > 0) {
      pendingMerge.current = new Map()
      mergeScene([...pending.values()])
    }
    flushDeferred()
  }

  /** Apply the ops that were postponed because the person held those elements. */
  function flushDeferred() {
    if (deferredOps.current.length === 0) return
    const instance = apiRef.current
    if (instance === null) return
    const busy = busyIds(instance.getAppState())
    const ready = deferredOps.current.filter((item) => item.ids.every((id) => !busy.has(id)))
    if (ready.length === 0) return
    deferredOps.current = deferredOps.current.filter((item) => !ready.includes(item))

    const elements = sceneMap()
    let changed = false
    for (const item of ready) {
      for (const op of item.ops) {
        if (applyClientOp(elements, op, tools())) changed = true
      }
    }
    if (!changed) return
    applyScene([...elements.values()])
    report('panel.txDeferred', { count: ready.reduce((sum, item) => sum + item.ids.length, 0) })
    scheduleSave()
  }

  function applyTxOnce(frame, atRevision) {
    const instance = apiRef.current
    if (instance === null) return null
    const app = instance.getAppState()
    const busy = busyIds(app)
    const elements = sceneMap()
    const deferred = []
    let changed = false

    for (const op of frame.ops) {
      const targets = idsOfOp(op)
      if (targets.some((id) => busy.has(id))) {
        deferred.push(...targets)
        continue
      }
      if (applyClientOp(elements, op, tools())) changed = true
    }

    const held = new Set(frame.ids.filter((id) => !deferred.includes(id)))
    for (const id of held) {
      const element = elements.get(id)
      if (element === undefined) continue
      const lease = leasesRef.current.get(id) ?? { txId: frame.txId, until: Date.now() + 20_000 }
      elements.set(id, lockOnClient(element, lease, Date.now()))
      changed = true
    }

    if (changed) applyScene([...elements.values()])

    const committed = [...elements.values()]
    return api
      .commit({
        txId: frame.txId,
        baseRev: atRevision,
        elements: committed,
        appState: pickAppState(instance.getAppState()),
        files: instance.getFiles(),
        deferred: [...new Set(deferred)],
      })
      .then((result) => ({ result, deferred: [...new Set(deferred)], signature: sceneSignature(committed) }))
      .catch(async (error) => {
        if (error.code !== 'stale-revision') throw error
        await resync()
        return { result: null, deferred: [...new Set(deferred)], stale: true }
      })
  }

  async function applyTx(frame) {
    txOpen.current = true
    try {
      let attempt = await applyTxOnce(frame, frame.rev)
      if (attempt?.stale === true) attempt = await applyTxOnce(frame, baseRev.current)
      if (attempt?.result === null || attempt === null) {
        report('panel.txFailed', { message: 'revision' })
        return
      }
      accept(attempt.result.rev)
      lastSaved.current = attempt.signature ?? lastSaved.current
      if (attempt.deferred.length > 0) {
        const deferredSet = new Set(attempt.deferred)
        const ops = frame.ops.filter((op) => idsOfOp(op).every((id) => deferredSet.has(id)))
        if (ops.length > 0) deferredOps.current.push({ ids: [...deferredSet], ops })
        report('panel.txDeferred', { count: deferredSet.size })
      }
    } catch (error) {
      report('panel.txFailed', { message: error.message })
    } finally {
      txOpen.current = false
      if (dirtyDuringTx.current) {
        dirtyDuringTx.current = false
        scheduleSave()
      }
    }
  }

  function enqueueTx(frame) {
    txChain.current = txChain.current.then(
      () => applyTx(frame),
      () => applyTx(frame),
    )
  }

  function dispatch(frame) {
    switch (frame.frame) {
      case 'hello':
        setConnected(true)
        if (frame.rev !== baseRev.current) void resync().catch(() => undefined)
        break
      case 'scene':
        accept(frame.rev)
        setLeaseList(frame.leases)
        mergeScene(frame.elements)
        break
      case 'tx':
        txOpen.current = true
        enqueueTx(frame)
        break
      case 'settled':
        accept(frame.rev)
        setLeaseList(frame.leases)
        mergeScene(frame.elements)
        break
      case 'event':
        propsRef.current.onEvent?.(frame.event)
        if (propsRef.current.follow === true) locate(bindingOf(frame.event), { scroll: false })
        break
      default:
        break
    }
  }

  function connect(setSource) {
    let source
    try {
      source = new EventSource(STREAM)
    } catch {
      setConnected(false)
      return () => {}
    }
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (message) => {
      let frame
      try {
        frame = JSON.parse(message.data)
      } catch {
        return
      }
      dispatch(frame)
    }
    setSource(source)
    return () => {
      source.close()
      setConnected(false)
    }
  }

  function addEvent(event, point) {
    const instance = apiRef.current
    if (instance === null) return false
    const app = instance.getAppState()
    const host = hostRef.current
    let at = point
    if (at === undefined && host !== null) {
      const rect = host.getBoundingClientRect()
      at = vendorRef.current.viewportCoordsToSceneCoords(
        { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 },
        app,
      )
    }
    if (at === undefined) at = { x: 0, y: 0 }
    const headline = `${event.label ?? event.type}：${event.summary ?? ''}`.slice(0, 90)
    const converted = vendorRef.current.convertToExcalidrawElements(
      [
        {
          type: 'rectangle',
          x: Math.round(at.x - 150),
          y: Math.round(at.y - 45),
          width: 300,
          height: 90,
          backgroundColor: '#fff3bf',
          strokeColor: '#e8590c',
          fillStyle: 'solid',
          strokeWidth: 1,
          label: { text: headline || event.type },
        },
      ],
      { regenerateIds: false },
    )
    if (!Array.isArray(converted) || converted.length === 0) return false
    const meta = { origin: 'user', binding: [bindingOf(event)] }
    for (const element of converted) {
      element.customData = { ...(element.customData ?? {}), dsh: meta }
    }
    applyScene([...scene(), ...converted])
    instance.scrollToContent(converted, { fitToContent: false, animate: true, duration: 250 })
    scheduleSave()
    return true
  }

  function locate(binding, options = {}) {
    const instance = apiRef.current
    if (instance === null) return 0
    const matches = instance.getSceneElements().filter((element) => hasBinding(element, binding))
    if (matches.length === 0) return 0
    applyScene(scene(), { elementsToHighlight: matches })
    if (options.scroll !== false) {
      instance.scrollToContent(matches, { fitToContent: true, animate: true, duration: 300 })
    }
    setTimeout(() => {
      if (apiRef.current !== null) applyScene(scene(), { elementsToHighlight: [] })
    }, HIGHLIGHT_MS)
    return matches.length
  }

  function fit() {
    const instance = apiRef.current
    if (instance === null) return
    instance.scrollToContent(instance.getSceneElements(), { fitToContent: true, animate: true, duration: 300 })
  }

  async function takeBack() {
    const txIds = [...new Set([...leasesRef.current.values()].map((lease) => lease.txId))]
    if (txIds.length === 0) return
    await Promise.allSettled(txIds.map((txId) => api.cancel(txId)))
    report('panel.released')
  }

  function selectionChanged(appState) {
    const selected = Object.keys(appState?.selectedElementIds ?? {})
    if (selected.length === 0 || selected.length > MAX_SELECTION_REPORT) {
      propsRef.current.onSelection?.([])
      return
    }
    const byId = new Map(scene().map((element) => [element.id, element]))
    const summaries = []
    for (const id of selected) {
      const element = byId.get(id)
      if (element === undefined) continue
      summaries.push({ id, type: element.type, binding: bindingsOf(element) })
    }
    propsRef.current.onSelection?.(summaries)
  }

  return {
    tools,
    busyIds,
    applyScene,
    mergeScene,
    resync,
    saveNow,
    scheduleSave,
    flushPending,
    flushDeferred,
    enqueueTx,
    dispatch,
    connect,
    addEvent,
    locate,
    fit,
    takeBack,
    selectionChanged,
    setLeaseList,
    accept,
  }
}

/**
 * @param {{ React: object, api: object }} deps
 */
export function createCanvas({ React, api }) {
  const { useCallback, useEffect, useMemo, useRef, useState } = React

  return function Canvas(props) {
    const { t, lang, colorScheme = 'light', canvasRef } = props

    const [phase, setPhase] = useState('vendor')
    const [failure, setFailure] = useState(null)
    const [rev, setRev] = useState(0)
    const [leases, setLeases] = useState([])
    const [connected, setConnected] = useState(false)
    const [empty, setEmpty] = useState(true)

    const vendorRef = useRef(null)
    const apiRef = useRef(null)
    const hostRef = useRef(null)
    const initial = useRef(null)
    const baseRev = useRef(0)
    const leasesRef = useRef(new Map())
    const lastApplied = useRef(null)
    const lastSaved = useRef('')
    const txOpen = useRef(false)
    const dirtyDuringTx = useRef(false)
    const pendingMerge = useRef(new Map())
    const deferredOps = useRef([])
    const saveTimer = useRef(0)
    const saveChain = useRef(Promise.resolve())
    const txChain = useRef(Promise.resolve())
    const sourceRef = useRef(null)
    const selectionKey = useRef('')
    const propsRef = useRef(props)
    propsRef.current = props

    const report = useCallback((key, vars) => {
      const current = propsRef.current
      current.onToast?.(current.t?.(key, vars) ?? key)
    }, [])

    const engine = useMemo(
      () =>
        createEngine({
          api,
          propsRef,
          vendorRef,
          apiRef,
          hostRef,
          baseRev,
          leasesRef,
          lastApplied,
          lastSaved,
          txOpen,
          dirtyDuringTx,
          pendingMerge,
          deferredOps,
          saveTimer,
          saveChain,
          txChain,
          setRev,
          setLeases,
          setConnected,
          report,
        }),
      [api, report],
    )

    // 1. Vendor bundle, then the scene it renders.
    useEffect(() => {
      let live = true
      setPhase('vendor')
      setFailure(null)
      loadVendor(props.require)
        .then((module) => {
          if (!live) return
          vendorRef.current = module
          setPhase('state')
        })
        .catch((error) => {
          if (!live) return
          setFailure(error)
          setPhase('error')
        })
      return () => {
        live = false
      }
    }, [props.require, props.retryKey])

    useEffect(() => {
      if (phase !== 'state') return undefined
      let live = true
      api
        .state()
        .then((payload) => {
          if (!live) return
          initial.current = {
            elements: payload.elements,
            appState: payload.appState,
            files: payload.files,
          }
          engine.accept(payload.rev)
          engine.setLeaseList(payload.leases)
          lastSaved.current = sceneSignature(payload.elements ?? [])
          setEmpty(Array.isArray(payload.elements) && payload.elements.length === 0)
          propsRef.current.onEvents?.(payload.events ?? [])
          setPhase('ready')
        })
        .catch((error) => {
          if (!live) return
          setFailure(error)
          setPhase('error')
        })
      return () => {
        live = false
      }
    }, [phase, api, engine])

    // 2. One stream for board frames and session events.
    useEffect(() => {
      if (phase !== 'ready') return undefined
      return engine.connect((source) => {
        sourceRef.current = source
      })
    }, [phase, engine])

    useEffect(() => {
      return () => {
        clearTimeout(saveTimer.current)
        sourceRef.current?.close()
      }
    }, [])

    const handleChange = useCallback(
      (elements, appState) => {
        if (elements === lastApplied.current) return
        if (phase !== 'ready') return
        setEmpty(elements.filter((element) => element.isDeleted !== true).length === 0)
        const selected = Object.keys(appState?.selectedElementIds ?? {})
        const key = selected.sort().join(',')
        if (key !== selectionKey.current) {
          selectionKey.current = key
          engine.selectionChanged(appState)
        }
        engine.scheduleSave()
      },
      [engine, phase],
    )

    const handlePointerUp = useCallback(() => {
      setTimeout(() => engine.flushPending(), 60)
    }, [engine])

    const handleDrop = useCallback(
      (event) => {
        event.preventDefault()
        const raw = event.dataTransfer?.getData('application/x-dsh-event')
        if (typeof raw !== 'string' || raw === '') return
        try {
          const record = JSON.parse(raw)
          const point = vendorRef.current?.viewportCoordsToSceneCoords(
            { clientX: event.clientX, clientY: event.clientY },
            apiRef.current.getAppState(),
          )
          engine.addEvent(record, point)
        } catch {
          // A malformed drag is ignored; the rail still offers its button.
        }
      },
      [engine],
    )

    useEffect(() => {
      if (canvasRef === undefined || canvasRef === null) return
      canvasRef.current = {
        addEvent: (record) => engine.addEvent(record),
        locate: (binding, options) => engine.locate(binding, options),
        fit: () => engine.fit(),
        takeBack: () => engine.takeBack(),
        flush: () => engine.flushPending(),
      }
    }, [canvasRef, engine])

    useEffect(() => {
      propsRef.current.onStatus?.({ rev, leases, connected, empty })
    }, [rev, leases, connected, empty])

    if (phase === 'vendor' || phase === 'state') {
      return React.createElement(
        'div',
        { className: 'dsh-xc-state' },
        React.createElement('div', { className: 'dsh-xc-spinner', 'aria-hidden': 'true' }),
        React.createElement('p', null, t('panel.loading')),
      )
    }

    if (phase === 'error') {
      return React.createElement(
        'div',
        { className: 'dsh-xc-state dsh-xc-state-error', role: 'alert' },
        React.createElement('p', null, t('panel.error', { message: failure?.message ?? String(failure) })),
        React.createElement(
          'button',
          { type: 'button', className: 'dsh-xc-btn', onClick: () => props.onRetry?.() },
          t('panel.retry'),
        ),
      )
    }

    const vendor = vendorRef.current
    return React.createElement(
      'div',
      {
        className: 'dsh-xc-board',
        ref: hostRef,
        onDragOver: (event) => {
          event.preventDefault()
        },
        onDrop: handleDrop,
      },
      React.createElement(vendor.Excalidraw, {
        initialData: initial.current,
        excalidrawAPI: (instance) => {
          apiRef.current = instance
          // Adopt the scene Excalidraw just restored: every later render calls
          // `onChange` with this same array, and an untouched board must not
          // rewrite itself.
          lastApplied.current = instance.getSceneElementsIncludingDeleted()
        },
        theme: colorScheme === 'dark' ? 'dark' : 'light',
        langCode: lang === 'zh' ? 'zh-CN' : 'en',
        isCollaborating: false,
        autoFocus: true,
        handleKeyboardGlobally: false,
        UIOptions: {
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
          },
        },
        onChange: handleChange,
        onPointerUp: handlePointerUp,
      }),
      empty
        ? React.createElement(
            'div',
            { className: 'dsh-xc-empty', 'aria-hidden': 'true' },
            React.createElement('span', null, t('panel.empty')),
          )
        : null,
    )
  }
}
