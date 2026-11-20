/**
 * Agent tools over the board.
 *
 * Every tool answers with a value, never a throw: a wrong id costs the model one
 * line of explanation instead of a failed turn. The descriptions are the model's
 * only manual, so they say what the board is, how ops are shaped, and what a
 * `pending` result means.
 *
 * @module dsh-excalidraw/tools
 */

import { normalizeOps, OpError, summarizeOps } from './ops.js'
import { oneLine } from './shared/protocol.js'

const text = (value) => [{ type: 'text', text: value }]

const failure = (value) => text(`${value.reason}: ${value.error}`)

/** Common result envelope: a model reads `ok`, a person reads the rendered line. */
function resultShape(extra = {}) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      reason: { type: 'string' },
      error: { type: 'string' },
      ...extra,
    },
    additionalProperties: true,
  }
}

/**
 * @param {{
 *   store: object,
 *   journal: object,
 *   presence: object,
 *   config: { board: string, waitMs: number, leaseMs: number },
 *   now: () => number,
 * }} deps
 */
export function createTools(deps) {
  const { store, journal, presence, config, now } = deps

  /** Latest observable seq for one session, so a binding can name a real event. */
  function latestEvent(sessionId) {
    const events = journal.recent(200).filter((event) => event.sessionId === sessionId)
    return events.length === 0 ? undefined : events[events.length - 1]
  }

  /** Every failure becomes a value; only a genuine bug escapes as a throw. */
  async function attempt(operation) {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof OpError) return { ok: false, reason: error.code, error: error.message }
      if (typeof error?.code === 'string' && error.code !== 'internal') {
        return { ok: false, reason: error.code, error: error.message, ...(Number.isInteger(error.rev) ? { rev: error.rev } : {}) }
      }
      throw error
    }
  }

  const base = (name, description, parameters, extra) => ({
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, ...parameters },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    ...extra,
  })

  return [
    base(
      'excalidraw_read',
      '读画板。默认返回每个元素的摘要（id、类型、位置、文字、锁、绑定）；full=true 返回完整 Excalidraw JSON。改元素前先用它拿 id。',
      {
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '只读这些元素；省略 = 全部' },
          full: { type: 'boolean', description: '返回完整元素 JSON' },
          limit: { type: 'integer', description: '摘要最多几条（默认 200）' },
        },
      },
      {
        isConcurrencySafe: () => true,
        output: {
          schema: resultShape({
            board: { type: 'string' },
            rev: { type: 'integer' },
            total: { type: 'integer' },
            elements: { type: 'array', items: { type: 'object' } },
            leases: { type: 'array', items: { type: 'object' } },
          }),
          render: (_args, value) => {
            if (value.ok !== true) return failure(value)
            if (Array.isArray(value.elements) && value.elements[0]?.type !== undefined && value.full === true) {
              return text(JSON.stringify({ board: value.board, rev: value.rev, elements: value.elements }, null, 2))
            }
            const lines = [
              `画板 ${value.board}（rev ${value.rev}，${value.total} 个元素${value.truncated ? '，已截断' : ''}）`,
            ]
            for (const element of value.elements ?? []) {
              const parts = [`${element.id}`, element.type, `(${element.x},${element.y}) ${element.width}×${element.height}`]
              if (element.text !== undefined) parts.push(JSON.stringify(element.text))
              if (element.locked) parts.push('locked')
              if (element.held !== undefined) parts.push(`held:${element.held}`)
              if (element.binding !== undefined) {
                const first = element.binding[element.binding.length - 1]
                parts.push(`绑定 ${first.sessionId}#${first.seq}`)
              }
              lines.push(`- ${parts.join(' · ')}`)
            }
            if ((value.leases ?? []).length > 0) lines.push(`持有中：${value.leases.map((lease) => lease.id).join(', ')}`)
            return text(lines.join('\n'))
          },
        },
        async execute(args) {
          return attempt(async () => {
            await store.ready()
            if (args?.full === true) {
              const full = store.readFull({ ids: args?.ids })
              return { ok: true, full: true, ...full }
            }
            const read = store.read({ ids: args?.ids, limit: Number.isInteger(args?.limit) ? args.limit : 200 })
            return { ok: true, ...read }
          })
        },
      },
    ),

    base(
      'excalidraw_apply',
      '改画板。ops 是操作数组：create {op:"create", element:{type,x,y,width,height,text?,...}}；patch {op:"patch", id, set}；delete {op:"delete", id}；lock/unlock {op:"lock", ids}。' +
        '只要画板开着，被改的元素会先被锁住（用户不能误动），用户正在拖的那个会推迟到松手；返回 pending 表示画板还没确认，可用 excalidraw_status 查。',
      {
        properties: {
          ops: { type: 'array', items: { type: 'object' }, description: '操作数组，按顺序应用' },
          waitMs: { type: 'integer', description: '等画板确认的毫秒数（默认 1500）' },
        },
        required: ['ops'],
      },
      {
        output: {
          schema: resultShape({
            status: { type: 'string' },
            txId: { type: 'string' },
            rev: { type: 'integer' },
            ids: { type: 'array', items: { type: 'string' } },
            missing: { type: 'array', items: { type: 'string' } },
            deferred: { type: 'array', items: { type: 'string' } },
          }),
          render: (_args, value) => {
            if (value.ok !== true) return failure(value)
            const head = {
              committed: '已应用，画板已确认',
              headless: '已写入画板（画板没开，无人需要确认）',
              pending: '已写入，等待画板确认',
              cancelled: '用户收回了控制权，改动已撤销',
              expired: '等待超时，锁已自动释放',
            }[value.status] ?? value.status
            const lines = [`${head}（rev ${value.rev}）`, `tx ${value.txId}`]
            if ((value.ids ?? []).length > 0) lines.push(`元素：${value.ids.join(', ')}`)
            if ((value.created ?? []).length > 0) lines.push(`新建：${value.created.join(', ')}`)
            if ((value.missing ?? []).length > 0) lines.push(`不存在的 id：${value.missing.join(', ')}`)
            if ((value.deferred ?? []).length > 0) lines.push(`用户正在操作、稍后应用：${value.deferred.join(', ')}`)
            return text(lines.join('\n'))
          },
        },
        async execute(args, exec) {
          return attempt(async () => {
            await store.ready()
            const normalized = normalizeOps(args?.ops, { now: now() })
            const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined
            const opened = await store.apply(normalized.ops, {
              lock: presence.connected,
              leaseMs: config.leaseMs,
              sessionId,
              summary: summarizeOps(normalized.ops),
            })
            const outcome = opened.pending
              ? await opened.waitFor(Number.isInteger(args?.waitMs) ? args.waitMs : config.waitMs)
              : { status: 'headless' }
            return {
              ok: true,
              status: outcome.status,
              txId: opened.txId,
              rev: opened.rev,
              ids: opened.ids,
              created: opened.created,
              missing: opened.missing,
              deferred: outcome.deferred ?? [],
            }
          })
        },
      },
    ),

    base(
      'excalidraw_bind',
      '把一个或多个画板元素绑定到一条会话事件（默认当前会话最近的一条）。绑定后点元素就能回到那条事件，元素上会显示事件摘要。',
      {
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '要绑定的元素 id' },
          sessionId: { type: 'string', description: '会话 id；省略 = 当前会话' },
          seq: { type: 'integer', description: '事件 seq；省略 = 该会话最近一条' },
          note: { type: 'string', description: '给人看的短标签' },
        },
        required: ['ids'],
      },
      {
        output: {
          schema: resultShape({ rev: { type: 'integer' }, changed: { type: 'array', items: { type: 'string' } } }),
          render: (_args, value) =>
            value.ok !== true
              ? failure(value)
              : text(`已绑定 ${(value.changed ?? []).join(', ') || '（无变化）'} → ${value.binding?.sessionId ?? ''}#${value.binding?.seq ?? ''}`),
        },
        async execute(args, exec) {
          return attempt(async () => {
            await store.ready()
            const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : exec?.agent?.id
            if (typeof sessionId !== 'string' || sessionId === '') {
              return { ok: false, reason: 'invalid-request', error: '无法确定会话 id，请显式传 sessionId' }
            }
            const latest = latestEvent(sessionId)
            const seq = Number.isInteger(args?.seq) ? args.seq : latest?.seq ?? 0
            const type = latest?.seq === seq ? latest?.type : 'manual'
            const binding = {
              sessionId,
              seq,
              type: type ?? 'manual',
              at: now(),
              label: oneLine(args?.note ?? latest?.summary ?? '', 120),
            }
            const bound = await store.bind(args.ids, binding)
            return { ok: true, rev: bound.rev, changed: bound.changed, binding }
          })
        },
      },
    ),

    base(
      'excalidraw_status',
      '查画板状态：当前版本、哪些元素被锁住、某个事务的进展。',
      {
        properties: {
          txId: { type: 'string', description: '事务 id；省略 = 只报画板状态' },
        },
      },
      {
        isConcurrencySafe: () => true,
        output: {
          schema: resultShape({ rev: { type: 'integer' }, leases: { type: 'array', items: { type: 'object' } } }),
          render: (_args, value) => {
            if (value.ok !== true) return failure(value)
            const lines = [`画板 ${value.board} rev ${value.rev}，${value.presence} 个面板连接`]
            lines.push((value.leases ?? []).length === 0 ? '没有元素被锁住' : `锁住：${value.leases.map((lease) => `${lease.id}（${lease.txId}）`).join(', ')}`)
            if (value.tx !== undefined) lines.push(`事务 ${value.tx.txId}：${value.tx.status}`)
            return text(lines.join('\n'))
          },
        },
        async execute(args) {
          return attempt(async () => {
            await store.ready()
            const head = store.head()
            return {
              ok: true,
              board: head.board,
              rev: head.rev,
              leases: head.leases,
              presence: presence.count,
              ...(typeof args?.txId === 'string' && args.txId !== '' ? { tx: store.status(args.txId) } : {}),
            }
          })
        },
      },
    ),

    base(
      'excalidraw_release',
      '提前释放被 agent 锁住的元素。用户要接手、或你决定不改了的时候用。',
      {
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '要释放的元素 id' },
          all: { type: 'boolean', description: '释放全部' },
        },
      },
      {
        output: {
          schema: resultShape({ rev: { type: 'integer' }, released: { type: 'integer' } }),
          render: (_args, value) =>
            value.ok !== true ? failure(value) : text(`已释放 ${value.released} 个元素（rev ${value.rev}）`),
        },
        async execute(args) {
          return attempt(async () => {
            await store.ready()
            const ids = args?.all === true ? 'all' : Array.isArray(args?.ids) ? args.ids : []
            const released = await store.release(ids)
            return { ok: true, ...released }
          })
        },
      },
    ),
  ]
}
