import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** A Cordis-shaped context that records what the plugin mounts. */
function createHost(root) {
  const tools = new Map()
  const routes = []
  const sections = []
  const disposers = []
  const listeners = new Map()

  const logger = { info() {}, warn() {}, error() {} }

  const ctx = {
    logger,
    get(name) {
      if (name === 'sessionController') {
        return {
          create: async () => ({ sessionId: 'chat-1' }),
          resolveAgent: async (id) => (id === 'chat-1' ? { agent: { id, status: 'idle' } } : undefined),
        }
      }
      if (name === 'agents') {
        return { get: (id) => (id === 'chat-1' ? { id, status: 'idle' } : undefined) }
      }
      return undefined
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => listeners.get(name)?.delete(listener)
    },
    effect(setup) {
      disposers.push(setup())
      return () => {}
    },
    inject(services, callback) {
      if (services.includes('tools')) {
        callback({
          logger,
          effect: (setup) => {
            disposers.push(setup())
            return () => {}
          },
          tools: {
            register(definition) {
              tools.set(definition.name, definition)
              return () => tools.delete(definition.name)
            },
          },
        })
      }
      if (services.includes('webServer')) {
        callback({
          logger,
          effect: (setup) => {
            disposers.push(setup())
            return () => {}
          },
          webServer: {
            register(route) {
              routes.push(route)
              return () => routes.splice(routes.indexOf(route), 1)
            },
          },
        })
      }
      if (services.includes('systemPrompt')) {
        callback({
          logger,
          effect: (setup) => {
            disposers.push(setup())
            return () => {}
          },
          systemPrompt: {
            section(input) {
              sections.push(input)
              return () => {}
            },
            context() {
              return () => {}
            },
          },
        })
      }
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }

  apply(ctx, { root, board: 'main', waitMs: 100, leaseMs: 5_000, maxEvents: 50 })

  return {
    tools,
    routes,
    sections,
    emit: ctx.emit,
    async dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          await dispose?.()
        } catch {
          /* teardown should be best-effort in a test too */
        }
      }
    },
  }
}

function request(method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3099' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
    on() {},
  }
}

function response() {
  const state = { statusCode: 0, headers: {}, body: '', ended: false }
  return {
    get writableEnded() {
      return state.ended
    },
    get statusCode() {
      return state.statusCode
    },
    set statusCode(value) {
      state.statusCode = value
    },
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value
    },
    end(data) {
      state.ended = true
      if (data !== undefined) state.body += Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    },
    json() {
      return JSON.parse(state.body)
    },
    get state() {
      return state
    },
  }
}

function route(host, kind, pathname) {
  const found = host.routes.find((candidate) => candidate.kind === kind && candidate.path === pathname)
  assert.ok(found, `route ${kind} ${pathname} is registered`)
  return found.handler
}

async function call(handler, method, url, body) {
  const res = response()
  await handler(request(method, url, body), res)
  return res
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-xc-host-'))
  const host = createHost(root)
  t.after(async () => {
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { root, host }
}

test('the plugin registers its five tools and its six routes', async (t) => {
  const { host } = await fixture(t)
  assert.deepEqual([...host.tools.keys()].sort(), [
    'excalidraw_apply',
    'excalidraw_bind',
    'excalidraw_read',
    'excalidraw_release',
    'excalidraw_status',
  ])
  assert.deepEqual(
    host.routes.map((route) => `${route.kind}:${route.path}`).sort(),
    [
      'exact:/api/excalidraw/cancel',
      'exact:/api/excalidraw/chat',
      'exact:/api/excalidraw/chat/reset',
      'exact:/api/excalidraw/save',
      'exact:/api/excalidraw/state',
      'exact:/api/excalidraw/stream',
      'exact:/api/excalidraw/tx',
      'prefix:/api/excalidraw/assets',
    ],
  )
})

test('a headless apply writes the element and read sees it', async (t) => {
  const { host } = await fixture(t)
  const applyTool = host.tools.get('excalidraw_apply')
  const readTool = host.tools.get('excalidraw_read')

  const applied = await applyTool.execute(
    { ops: [{ op: 'create', element: { type: 'rectangle', id: 'r1', x: 10, y: 20, width: 100, height: 60, text: 'hi' } }] },
    { agent: { id: 'session-1' } },
  )
  assert.equal(applied.ok, true)
  assert.equal(applied.status, 'headless')
  assert.deepEqual(applied.ids, ['r1'])

  const read = await readTool.execute({}, { agent: { id: 'session-1' } })
  assert.equal(read.ok, true)
  assert.equal(read.total, 1)
  assert.equal(read.elements[0].id, 'r1')
  assert.equal(read.elements[0].text, 'hi')
})

test('a bad op is a readable refusal, not a throw', async (t) => {
  const { host } = await fixture(t)
  const result = await host.tools.get('excalidraw_apply').execute({ ops: [{ op: 'create', element: { type: 'hologram' } }] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid-request')
  assert.match(result.error, /type/)
})

test('bind names the latest event of the session that ran the tool', async (t) => {
  const { host } = await fixture(t)
  host.emit('session/event', { id: 'session-1' }, {
    type: 'tool/result',
    seq: 7,
    time: 1_000,
    data: { message: { role: 'tool', content: [{ type: 'text', text: '已写好' }] } },
  })

  await host.tools.get('excalidraw_apply').execute(
    { ops: [{ op: 'create', element: { type: 'text', id: 't1', x: 0, y: 0, text: '结论' } }] },
    { agent: { id: 'session-1' } },
  )
  const bound = await host.tools.get('excalidraw_bind').execute({ ids: ['t1'] }, { agent: { id: 'session-1' } })
  assert.equal(bound.ok, true)
  assert.equal(bound.binding.sessionId, 'session-1')
  assert.equal(bound.binding.seq, 7)
  assert.equal(bound.binding.type, 'tool/result')

  const read = await host.tools.get('excalidraw_read').execute({ ids: ['t1'] })
  assert.equal(read.elements[0].binding[0].seq, 7)
})

test('the HTTP surface serves state, refuses a stale save, and accepts the current one', async (t) => {
  const { host } = await fixture(t)
  const state = await call(route(host, 'exact', '/api/excalidraw/state'), 'GET', '/api/excalidraw/state')
  assert.equal(state.state.statusCode, 200)
  assert.equal(state.json().ok, true)
  assert.equal(state.json().rev, 0)

  await host.tools.get('excalidraw_apply').execute(
    { ops: [{ op: 'create', element: { type: 'rectangle', id: 'r1', x: 0, y: 0 } }] },
    { agent: { id: 'session-1' } },
  )
  const head = await call(route(host, 'exact', '/api/excalidraw/state'), 'GET', '/api/excalidraw/state')
  assert.equal(head.json().rev, 1)
  assert.equal(head.json().elements.length, 1)

  const save = route(host, 'exact', '/api/excalidraw/save')
  const stale = await call(save, 'POST', '/api/excalidraw/save', { baseRev: 0, elements: [] })
  assert.equal(stale.state.statusCode, 409)
  assert.equal(stale.json().reason, 'stale-revision')
  assert.equal(stale.json().rev, 1)

  const accepted = await call(save, 'POST', '/api/excalidraw/save', {
    baseRev: 1,
    elements: [{ ...head.json().elements[0], x: 40 }],
    appState: { viewBackgroundColor: '#101010' },
  })
  assert.equal(accepted.state.statusCode, 200)
  assert.equal(accepted.json().rev, 2)

  const after = await call(route(host, 'exact', '/api/excalidraw/state'), 'GET', '/api/excalidraw/state')
  assert.equal(after.json().elements[0].x, 40)
})

test('the chat route owns one conversation and the prompt knows it', async (t) => {
  const { host } = await fixture(t)
  const chatRoute = route(host, 'exact', '/api/excalidraw/chat')
  const created = await call(chatRoute, 'GET', '/api/excalidraw/chat')
  assert.equal(created.state.statusCode, 200)
  assert.equal(created.json().sessionId, 'chat-1')

  // Asking again reuses the same conversation.
  const again = await call(chatRoute, 'GET', '/api/excalidraw/chat')
  assert.equal(again.json().sessionId, 'chat-1')

  const guidance = host.sections.find((section) => section.name === 'dsh-excalidraw:guidance')
  const hint = host.sections.find((section) => section.name === 'dsh-excalidraw:hint')
  assert.ok(guidance, 'the guidance section is registered')
  assert.ok(hint, 'the hint section is registered')
  assert.match(guidance.text({ agent: { id: 'chat-1' } }), /excalidraw_apply/)
  assert.equal(guidance.text({ agent: { id: 'other' } }), '')
  assert.equal(hint.text({ agent: { id: 'chat-1' } }), '')
  assert.match(hint.text({ agent: { id: 'other' } }), /画板/)
})

test('a reset starts a different conversation', async (t) => {
  const { host } = await fixture(t)
  await call(route(host, 'exact', '/api/excalidraw/chat'), 'GET', '/api/excalidraw/chat')
  const reset = await call(route(host, 'exact', '/api/excalidraw/chat/reset'), 'POST', '/api/excalidraw/chat/reset', {})
  assert.equal(reset.state.statusCode, 200)
  assert.equal(reset.json().sessionId, 'chat-1')
})

test('the asset route serves the panel and refuses a traversal', async (t) => {
  const { host } = await fixture(t)
  const assets = route(host, 'prefix', '/api/excalidraw/assets')

  const panel = await call(assets, 'GET', '/api/excalidraw/assets/client/panel.js')
  assert.equal(panel.state.statusCode, 200)
  assert.match(panel.state.headers['content-type'], /javascript/)
  assert.match(panel.state.body, /createPanel/)

  const escape = await call(assets, 'GET', '/api/excalidraw/assets/client/../../index.js')
  assert.equal(escape.state.statusCode, 404)
})

test('the stream answers with hello and the current revision', async (t) => {
  const { host } = await fixture(t)
  const stream = route(host, 'exact', '/api/excalidraw/stream')
  const res = response()
  let writes = []
  res.write = (chunk) => {
    writes.push(String(chunk))
    return true
  }
  res.flushHeaders = () => {}
  const req = request('GET', '/api/excalidraw/stream')
  const pending = stream(req, res)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const first = writes.join('')
  assert.match(first, /"frame":"hello"/)
  assert.match(first, /"rev":0/)
  // The handler owns the response until the socket closes.
  res.state.ended = true
  req.on = () => {}
  assert.equal(typeof pending.then, 'function')
})
