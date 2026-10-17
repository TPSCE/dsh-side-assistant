/**
 * Host-half smoke test for `dsh-side-assistant`.
 *
 * Runs the real `apply()` against a fake Context and drives the real HTTP
 * handler with real request streams. Nothing here is shipped (see `files` in
 * package.json); it exists so the Host half is verified without installing the
 * bundle or restarting the running Web process.
 *
 * The fake Context models the two facts the detached architecture rests on:
 * `sessionQuery` (discovery of detached Sessions) and `agents.create()` (the
 * creation itself). A catalogued child stands in for the previous,
 * subagent-based architecture throughout.
 *
 * Run: node test/host.smoke.mjs
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { apply, inject } from '../index.js'

const PATHS = {
  label: '侧边助手',
}

/** One appendable fake Session. */
function fakeSession(id) {
  return {
    id,
    appended: [],
    append(type, data) {
      this.appended.push({ type, data })
    },
  }
}

/** The descriptor a creation wrote, as `{ type, data }`. */
function descriptorOf(calls) {
  return calls.childSession.appended[0]
}

/**
 * Let a creation's background settle finish (greeting → flush → release).
 *
 * The press answers before the greeting turn ends, so a test that inspects those
 * counters has to drain the microtask queue the settle runs on.
 */
const settled = () => new Promise((resolve) => setImmediate(resolve))

/** Every non-descriptor append a creation wrote. */
function policyOf(calls) {
  return calls.childSession.appended.slice(1)
}

/** Collect what `apply` registered against a fake Context. */
function mount(config) {
  const effectLabels = []
  const disposers = []
  const routes = new Map()
  const calls = {
    listChildren: 0,
    listSessions: 0,
    observeSession: 0,
    create: 0,
    flush: 0,
    dispose: 0,
    followup: 0,
    whenIdle: 0,
    composeFrom: 0,
    /** Prompt contexts attached to a live child agent by the progress digest. */
    agentContexts: [],
    /** Every context registered on the created child, in order. */
    contexts: [],
  }

  /** Services the plugin, the parent and the child context answer `ctx.get()` with. */
  const services = {}

  /** One live main agent whose Session header and route the plugin reads. */
  function fakeParent(id, overrides = {}) {
    return {
      id,
      options: overrides.options ?? {
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'high',
        maxTokens: 4096,
        subagentDepth: undefined,
      },
      session: overrides.session ?? {
        header: { id, cwd: '/tmp/work', delegationDepth: 0 },
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } }),
      },
      ctx: { get: (name) => services[name] },
    }
  }

  let parent = fakeParent('s1')

  /** Framework events the Host half subscribes to (`session/event`, `agent/created`). */
  const listeners = new Map()

  const ctx = {
    effect(execute, label) {
      effectLabels.push(label)
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    get(name) {
      return services[name]
    },
    /** Subscribe like Cordis does; returns the disposer that unsubscribes. */
    on(name, listener) {
      const bag = listeners.get(name)
      if (bag === undefined) listeners.set(name, [listener])
      else bag.push(listener)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    /**
     * Deliver one framework event to the Host half.
     *
     * Awaited by the framework (`ctx.serial`), which matters for `agent/created`:
     * the Host half may still be scanning for assistants and answers with a promise.
     */
    async emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) await listener(...args)
    },
    webServer: {
      register(registered) {
        assert.equal(routes.has(registered.path), false, `duplicate route ${registered.path}`)
        routes.set(registered.path, registered)
        return () => {}
      },
    },
    agents: {
      live: true,
      get(id) {
        if (!ctx.agents.live) return undefined
        assert.equal(id, parent.session.header.id)
        return parent
      },
      async create(options) {
        calls.create += 1
        calls.lastCreate = options
        const session = fakeSession(options.sessionId)
        calls.childSession = session
        const childCtx = {
          get(name) {
            return services[name]
          },
          systemPrompt: {
            getContextOrder(name) {
              calls.lastContextOrder = name
              return 100
            },
            getSectionOrder(name) {
              calls.lastSectionOrder = name
              return 100
            },
            context(registered) {
              calls.context = registered
              calls.contexts.push(registered)
            },
            section(registered) {
              calls.section = registered
            },
          },
          tools: {
            restrict(filter) {
              calls.restrict = filter
            },
          },
        }
        const child = {
          id: options.sessionId,
          session,
          options: options.agentOptions,
          /** A live agent exposes its own scoped Context; the digest registers there. */
          ctx: {
            systemPrompt: {
              context(registered) {
                calls.agentContexts.push(registered)
              },
            },
          },
          followup(message) {
            calls.followup += 1
            calls.lastMessage = message
          },
          async whenIdle() {
            calls.whenIdle += 1
          },
        }
        // The real runtime composes the child inside the unpublished window.
        options.setup?.(childCtx, child)
        return {
          agent: child,
          async dispose() {
            calls.dispose += 1
          },
        }
      },
    },
    sessions: {
      async flush(session) {
        calls.flush += 1
        calls.lastFlushed = session.id
        if (ctx.sessions.failFlush) throw new Error('disk full')
      },
    },
    sessionQuery: {
      /** Detached Sessions the profile knows about. */
      records: [],
      /** The main Session's own events, as one observation. */
      events: [],
      async listSessions(signal) {
        calls.listSessions += 1
        assert.ok(signal instanceof AbortSignal, 'listSessions must receive the lifetime signal')
        return ctx.sessionQuery.records
      },
      async observeSession(sessionId, options) {
        calls.observeSession += 1
        calls.lastObserved = sessionId
        assert.ok(options.signal instanceof AbortSignal, 'observeSession must receive the lifetime signal')
        assert.equal(options.projectionMode, 'none')
        return { header: { id: sessionId }, events: ctx.sessionQuery.events }
      },
    },
    subagents: {
      children: [],
      async listChildren(parentSessionId, signal) {
        calls.listChildren += 1
        assert.equal(typeof parentSessionId, 'string')
        assert.ok(signal instanceof AbortSignal, 'listChildren must receive the lifetime signal')
        return ctx.subagents.children
      },
    },
  }

  ctx.setParent = (overrides) => {
    parent = fakeParent('s1', overrides)
  }

  apply(ctx, config)
  return { ctx, calls, effectLabels, routes, services, getRoute: (path = '/side-assistant/ensure') => routes.get(path) }
}

/** Drive the registered handler with one request. */
async function request(route, { method = 'POST', body } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : [])
  req.method = method

  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    body: null,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk
      this.headersSent = true
    },
  }

  await route.handler(req, res)
  return { status: res.statusCode, json: res.body === null ? null : JSON.parse(res.body), res }
}

/** A detached Session record, as `sessionQuery.listSessions()` reports one. */
function detached(id, { createdAt = Date.now(), parentSession = 's1', origin = 'subagent' } = {}) {
  return { header: { id, parentSession, origin, createdAt }, live: false, persisted: true }
}

/** A catalogued child, as the previous subagent-based architecture left one. */
function catalogued(id, { createdAt = Date.now() } = {}) {
  return { id, createdAt, mode: 'continuable', label: PATHS.label }
}

const STALE = Date.parse('2026-01-01T00:00:00Z')

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('declares exactly the services it uses', () => {
  assert.deepEqual(inject, ['agents', 'subagents', 'sessions', 'sessionQuery', 'webServer'])
})

test('registers the three exact routes, the progress watchers and one lifetime effect', () => {
  const { getRoute, effectLabels, routes } = mount(PATHS)
  const ensure = getRoute()
  assert.equal(ensure.kind, 'exact')
  assert.equal(ensure.path, '/side-assistant/ensure')
  assert.equal(typeof ensure.handler, 'function')

  const list = getRoute('/side-assistant/list')
  assert.equal(list.kind, 'exact')
  assert.equal(typeof list.handler, 'function')
  const preload = getRoute('/side-assistant/preload')
  assert.equal(preload.kind, 'exact')
  assert.equal(typeof preload.handler, 'function')
  assert.deepEqual([...routes.keys()], ['/side-assistant/ensure', '/side-assistant/list', '/side-assistant/preload'])
  assert.deepEqual(effectLabels, [
    'side-assistant: progress on agent/created',
    'side-assistant: progress on session/event',
    'side-assistant: adopt existing progress',
    'side-assistant: lifetime',
    'side-assistant: /side-assistant/ensure',
    'side-assistant: /side-assistant/list',
    'side-assistant: /side-assistant/preload',
  ])
})

test('first press creates one detached Session and answers with its id', async () => {
  const { calls, getRoute } = mount(PATHS)
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.created, true)
  assert.equal(typeof result.json.childId, 'string')
  assert.equal(calls.create, 1)
  assert.equal(result.res.headers['content-type'], 'application/json; charset=utf-8')
})

test('the Session is created without a parent Agent', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  // The whole point of the architecture: no runtime child relation, so nothing
  // in DSH can count this Session as a subagent.
  assert.equal('parentAgent' in calls.lastCreate, false)
  assert.equal(calls.lastCreate.parentAgent, undefined)
})

test('the Session header is detached lineage, not a delegation', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const { meta } = calls.lastCreate
  assert.equal(meta.parentSession, 's1')
  assert.equal(meta.origin, 'subagent')
  assert.equal(meta.cwd, '/tmp/work')
  assert.equal(meta.delegationDepth, 1)
  assert.equal('isSeeded' in meta, false, 'nothing is seeded: the pane starts on the greeting')
})

test('the main conversation becomes prompt context, not a copied transcript', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  ctx.sessionQuery.events = [
    { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '为什么侧边栏要显示主对话的记录？' }] } },
    {
      type: 'assistant/message',
      seq: 1,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '因为那是 fork 的历史快照。' }] } },
    },
    { type: 'turn/end', seq: 2 },
  ]

  await request(getRoute(), { body: { sessionId: 's1' } })

  assert.equal(calls.lastObserved, 's1')
  assert.equal('seed' in calls.lastCreate, false, 'no events are copied into the child')
  assert.equal('inheritedEventCount' in calls.lastCreate, false)
  // Nothing is registered at creation: a cold resume drops creation-time prompt
  // config, so the summary is attached by the same hook that attaches the blocks.
  assert.equal(calls.contexts.some((entry) => entry.name === 'side-assistant:history'), false)

  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  const digest = live.attached.find((entry) => entry.name === 'side-assistant:history')
  assert.ok(digest, 'the summary reaches the agent as prompt context')
  assert.equal(digest.order, 120)
  assert.ok(live.attached.some((entry) => entry.name === 'side-assistant:progress'), 'the blocks still attach')
  assert.match(digest.text, /为什么侧边栏要显示主对话的记录/)
  assert.match(digest.text, /因为那是 fork 的历史快照/)
  assert.match(digest.text, /not a transcript/)
})

test('the digest skips notices and stops at the last completed turn', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  ctx.sessionQuery.events = [
    { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改一下按钮' }] } },
    { type: 'turn/end', seq: 1 },
    { type: 'user/message', seq: 2, data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '助手已收尾' }] } },
    { type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '还没跑完的一步' }] } },
  ]

  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const digest = live.attached.find((entry) => entry.name === 'side-assistant:history')

  assert.match(digest.text, /改一下按钮/)
  assert.doesNotMatch(digest.text, /助手已收尾/, 'a settlement notice is not what the user said')
  assert.doesNotMatch(digest.text, /还没跑完的一步/, 'the turn in flight belongs to the progress blocks')
})

test('an older summarised line is dropped whole when the budget is exhausted', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  const events = []
  for (let turn = 0; turn < 20; turn += 1) {
    const text = turn === 0 ? `最早那一句${'嗯'.repeat(600)}` : `第 ${turn} 句${'呀'.repeat(600)}`
    events.push({ type: 'user/message', seq: turn * 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    events.push({ type: 'turn/end', seq: turn * 2 + 1 })
  }
  ctx.sessionQuery.events = events

  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const digest = live.attached.find((entry) => entry.name === 'side-assistant:history')

  assert.match(digest.text, /第 19 句/, 'the newest line survives')
  assert.doesNotMatch(digest.text, /最早那一句/, 'the oldest went whole, not clipped down to a stub')
})

test('a Session with no completed turn carries no summary', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  ctx.sessionQuery.events = [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '刚开始' }] } }]
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal('seed' in calls.lastCreate, false)
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  assert.equal(
    live.attached.some((entry) => entry.name === 'side-assistant:history'),
    false,
    'nothing to summarize means no fragment',
  )
})

test('the child writes its own continuable descriptor', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const descriptor = descriptorOf(calls)
  assert.equal(descriptor.type, 'subagent/descriptor')
  assert.equal(descriptor.data.version, 3)
  assert.equal(descriptor.data.mode, 'continuable')
  assert.equal(descriptor.data.provider, 'fork')
  assert.equal(descriptor.data.label, PATHS.label)
  assert.equal(descriptor.data.agentProvider, 'deepseek')
  assert.equal(descriptor.data.agentModel, 'deepseek-chat')
  assert.equal(descriptor.data.agentReasoningEffort, 'off')
  assert.match(descriptor.data.persona, /side assistant/)
  assert.deepEqual(descriptor.data.toolFilter, { deny: ['send_message'] })
})

test('the descriptor carries only fields the framework accepts', async () => {
  const { calls, getRoute, services } = mount({ reasoningEffort: 'inherit' })
  services.approval = { policy: () => 'ask' }
  await request(getRoute(), { body: { sessionId: 's1' } })
  // Unknown keys make `parseSubagentDescriptor` reject the whole descriptor, so
  // the key set is part of the contract.
  assert.deepEqual(Object.keys(descriptorOf(calls).data).sort(), [
    'agentModel',
    'agentProvider',
    'agentReasoningEffort',
    'label',
    'mode',
    'persona',
    'provider',
    'toolFilter',
    'version',
  ])
})

test('the child joins its parent’s preset and shadows persona and tools', async () => {
  const { calls, getRoute, services } = mount(PATHS)
  services.agentPresets = {
    composedPreset: () => 'preset-9',
    composeFrom: () => {
      calls.composeFrom += 1
    },
  }
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.composeFrom, 1)
  assert.equal(calls.lastCreate.meta.agentPreset, 'preset-9')
  assert.equal(calls.context.name, 'subagent:delegation')
  assert.equal(calls.lastContextOrder, 'SUBAGENT_DELEGATION')
  assert.match(calls.context.text, /delegated subagent/)
  assert.equal(calls.section.name, 'deployment:persona-prefix')
  assert.equal(calls.lastSectionOrder, 'DEPLOYMENT_PERSONA_PREFIX')
  assert.deepEqual(calls.restrict, { deny: ['send_message'] })
})

test('a profile without an agent-preset service still creates a Session', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.create, 1)
  assert.equal('agentPreset' in calls.lastCreate.meta, false)
  assert.equal(calls.composeFrom, 0)
})

test('an empty deny list restricts nothing', async () => {
  const { calls, getRoute } = mount({ denyTools: [] })
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.restrict, undefined)
  assert.equal('toolFilter' in descriptorOf(calls).data, false)
})

test('approval is pinned and the parent’s sandbox carries over', async () => {
  const { calls, getRoute, services } = mount(PATHS)
  services.permissionPresets = { current: () => 'read-only' }
  services.sandboxPolicy = { overrideOf: () => 'workspace-write' }
  services.approval = { policy: () => 'ask' }
  await request(getRoute(), { body: { sessionId: 's1' } })
  // A side assistant must never block on a prompt nobody is looking at, and the
  // narrowed sandbox must stay narrowed. A `read-only` preset is not carried.
  assert.deepEqual(policyOf(calls).map((entry) => entry.type), ['sandbox/mode', 'approval/policy'])
  assert.deepEqual(policyOf(calls).map((entry) => entry.data), [
    { mode: 'workspace-write', source: 'delegation' },
    { policy: 'never', source: 'delegation' },
  ])
})

test('a full-access permission preset is carried over', async () => {
  const { calls, getRoute, services } = mount(PATHS)
  services.permissionPresets = { current: () => 'danger-full-access' }
  services.approval = { policy: () => 'ask' }
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.deepEqual(policyOf(calls).map((entry) => entry.type), ['approval/policy', 'permission/preset'])
  assert.deepEqual(policyOf(calls)[1].data, { preset: 'danger-full-access' })
})

test('a profile without policy services appends no policy', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.deepEqual(policyOf(calls), [])
})

test('the greeting opens the first turn, then the agent is released', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  await settled()
  assert.equal(calls.followup, 1)
  assert.equal(calls.whenIdle, 1)
  assert.equal(calls.lastMessage.role, 'user')
  assert.equal(calls.lastMessage.content[0].text, 'hello')
  assert.deepEqual(calls.lastMessage.source, { kind: 'user' })
  assert.equal(typeof calls.lastMessage.id, 'string')
  // The flush must precede the release: `dispose()` unregisters the Session from
  // the runtime registry, and the log is what keeps it resumable.
  assert.equal(calls.flush, 1)
  assert.equal(calls.lastFlushed, calls.lastCreate.sessionId)
  assert.equal(calls.dispose, 1)
})

test('an empty opener opens on an empty conversation', async () => {
  const { calls, getRoute } = mount({ opener: '' })
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.json.created, true)
  await settled()
  assert.equal(calls.followup, 0)
  assert.equal(calls.whenIdle, 0)
  assert.equal(calls.dispose, 1)
})

test('row config can replace the opener', async () => {
  const { calls, getRoute } = mount({ opener: '在。' })
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.lastMessage.content[0].text, '在。')
})

test('a failed greeting still leaves a usable Session', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  const original = ctx.agents.create
  ctx.agents.create = async (options) => {
    const handle = await original(options)
    handle.agent.followup = () => {
      throw new Error('no route')
    }
    return handle
  }
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.json.ok, true)
  assert.equal(result.json.created, true)
  await settled()
  assert.equal(calls.dispose, 1)
})

test('a failed flush still answers with the Session', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessions.failFlush = true
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.json.ok, true)
  assert.equal(result.json.created, true)
})

test('the side assistant defaults to no reasoning effort', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.lastCreate.agentOptions.reasoningEffort, 'off')
})

test('it never overrides the parent’s provider or model', async () => {
  const { calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const options = calls.lastCreate.agentOptions
  assert.equal(options.provider, 'deepseek')
  assert.equal(options.model, 'deepseek-chat')
  assert.equal(options.maxTokens, 4096)
  assert.equal(options.subagentDepth, 1)
})

test('row config can override the effort', async () => {
  const { calls, getRoute } = mount({ reasoningEffort: 'max' })
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.lastCreate.agentOptions.reasoningEffort, 'max')
})

test('reasoningEffort: inherit keeps the parent’s requested effort', async () => {
  const { calls, getRoute } = mount({ reasoningEffort: 'inherit' })
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.lastCreate.agentOptions.reasoningEffort, 'high')
})

test('a parent with no requested route still yields options', async () => {
  const { ctx, calls, getRoute } = mount({ reasoningEffort: 'inherit' })
  ctx.setParent({
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { header: { id: 's1', delegationDepth: 2 }, requestHeader: () => undefined },
  })
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.lastCreate.agentOptions.provider, 'deepseek')
  assert.equal(calls.lastCreate.agentOptions.reasoningEffort, undefined)
  assert.equal(calls.lastCreate.meta.delegationDepth, 3)
  assert.equal(calls.lastCreate.agentOptions.subagentDepth, 3)
})

test('a second press reuses the detached Session it just made', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  const first = await request(getRoute(), { body: { sessionId: 's1' } })
  ctx.sessionQuery.records.push(detached(first.json.childId))
  const again = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.deepEqual(again.json, { ok: true, childId: first.json.childId, created: false })
  assert.equal(calls.create, 1)
})

test('the newest detached Session wins', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(
    detached('child-old', { createdAt: Date.now() - 5000 }),
    detached('child-new', { createdAt: Date.now() }),
  )
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.deepEqual(result.json, { ok: true, childId: 'child-new', created: false })
})

test('a catalogued Session is never a side assistant', async () => {
  const { ctx, getRoute } = mount(PATHS)
  // Every side assistant of the previous architecture is catalogued on the main
  // Session, so the exclusion is what keeps them out of the menu.
  ctx.sessionQuery.records.push(detached('child-legacy'))
  ctx.subagents.children.push(catalogued('child-legacy'))
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.json.created, true)
  assert.notEqual(result.json.childId, 'child-legacy')
})

test('an archived Session is not a side assistant', async () => {
  const { ctx, getRoute, services } = mount(PATHS)
  // Deleting archives: the log stays on disk and `listSessions` keeps reporting
  // it, so the archive set is the only thing that hides it.
  ctx.sessionQuery.records.push(detached('child-deleted'))
  services.workspaceRegistry = { archivedSessionIds: ['child-deleted'] }
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.json.created, true, 'a deleted assistant must not be reopened')
  assert.notEqual(result.json.childId, 'child-deleted')
})

test('the archive set is read per press, so a restore brings the assistant back', async () => {
  const { ctx, getRoute, services } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-deleted'))
  services.workspaceRegistry = { archivedSessionIds: ['child-deleted'] }
  await request(getRoute('/side-assistant/list'), { body: { sessionId: 's1' } })
  services.workspaceRegistry = { archivedSessionIds: [] }
  const listed = await request(getRoute('/side-assistant/list'), { body: { sessionId: 's1' } })
  assert.deepEqual(listed.json.assistants.map((row) => row.childId), ['child-deleted'])
})

test('a missing workspace registry hides nothing', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-kept'))
  const listed = await request(getRoute('/side-assistant/list'), { body: { sessionId: 's1' } })
  assert.deepEqual(listed.json.assistants.map((row) => row.childId), ['child-kept'])
})

test('Sessions of another parent or another origin are ignored', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(
    detached('child-elsewhere', { parentSession: 's2' }),
    // A plain forked Session has no `origin` at all and must not be adopted.
    { header: { id: 'child-forked', parentSession: 's1', createdAt: Date.now() } },
  )
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.json.created, true)
})

test('a Session born before the current composition is replaced', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-stale', { createdAt: STALE }))
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.json.created, true)
  assert.notEqual(result.json.childId, 'child-stale')
})

test('a Session with no usable instant is accepted', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push({ header: { id: 'child-noclock', parentSession: 's1', origin: 'subagent' } })
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.deepEqual(result.json, { ok: true, childId: 'child-noclock', created: false })
})

test('concurrent presses collapse onto one Session', async () => {
  const { calls, getRoute } = mount(PATHS)
  // The startup scan lists Sessions once by itself; the presses must add exactly one.
  const baseline = calls.listSessions
  const route = getRoute()
  const [a, b] = await Promise.all([
    request(route, { body: { sessionId: 's1' } }),
    request(route, { body: { sessionId: 's1' } }),
  ])
  assert.equal(calls.create, 1)
  assert.equal(calls.listSessions - baseline, 1)
  assert.equal(a.json.childId, b.json.childId)
})

test('create:true always makes another one', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  const first = await request(getRoute(), { body: { sessionId: 's1' } })
  ctx.sessionQuery.records.push(detached(first.json.childId))
  const again = await request(getRoute(), { body: { sessionId: 's1', create: true } })
  assert.equal(again.json.created, true)
  assert.notEqual(again.json.childId, first.json.childId)
  assert.equal(calls.create, 2)
})

test('two concurrent new-assistant presses collapse onto one Session', async () => {
  const { calls, getRoute } = mount(PATHS)
  const route = getRoute()
  const [a, b] = await Promise.all([
    request(route, { body: { sessionId: 's1', create: true } }),
    request(route, { body: { sessionId: 's1', create: true } }),
  ])
  assert.equal(calls.create, 1)
  assert.equal(a.json.childId, b.json.childId)
})

test('a new-assistant press is not merged into a plain press', async () => {
  const { calls, getRoute } = mount(PATHS)
  const route = getRoute()
  const [, created] = await Promise.all([
    request(route, { body: { sessionId: 's1' } }),
    request(route, { body: { sessionId: 's1', create: true } }),
  ])
  assert.equal(calls.create, 2)
  assert.equal(created.json.created, true)
})

test('a press can reopen an older assistant by id', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(
    detached('child-old', { createdAt: Date.now() - 5000 }),
    detached('child-new', { createdAt: Date.now() }),
  )
  const result = await request(getRoute(), { body: { sessionId: 's1', childId: 'child-old' } })
  assert.deepEqual(result.json, { ok: true, childId: 'child-old', created: false })
  assert.equal(calls.create, 0)
})

test('an id that is not this Session’s assistant is refused', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-stale', { createdAt: STALE }))
  ctx.subagents.children.push(catalogued('child-legacy'))
  for (const childId of ['child-stale', 'child-legacy', 'child-missing']) {
    const result = await request(getRoute(), { body: { sessionId: 's1', childId } })
    assert.equal(result.json.ok, false, `${childId} must be refused`)
    assert.equal(result.json.error, 'unknown-child')
  }
})

test('list reports the assistants oldest first', async () => {
  const { ctx, getRoute } = mount(PATHS)
  const base = Date.now()
  ctx.sessionQuery.records.push(
    detached('child-new', { createdAt: base }),
    detached('child-old', { createdAt: base - 5000 }),
  )
  const result = await request(getRoute('/side-assistant/list'), { body: { sessionId: 's1' } })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.assistants.map((row) => row.childId), ['child-old', 'child-new'])
  assert.equal(result.json.assistants[0].label, PATHS.label)
})

test('list leaves out catalogued and stale Sessions', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(
    detached('child-legacy'),
    detached('child-stale', { createdAt: STALE }),
  )
  ctx.subagents.children.push(catalogued('child-legacy'))
  const result = await request(getRoute('/side-assistant/list'), { body: { sessionId: 's1' } })
  assert.deepEqual(result.json.assistants, [])
})

test('a missing sessionId is reported as a business failure, not a crash', async () => {
  const { getRoute } = mount(PATHS)
  const result = await request(getRoute(), { body: {} })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'missing-session-id')
})

test('an unknown Session is reported as session/not-found', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.agents.live = false
  const result = await request(getRoute(), { body: { sessionId: 'ghost' } })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'session/not-found')
})

test('a refused creation is reported with its reason', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.agents.create = async () => {
    throw new Error('no usable cwd')
  }
  const result = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'create-failed')
  assert.match(result.json.message, /no usable cwd/)
})

test('a malformed body is a 400', async () => {
  const { getRoute } = mount(PATHS)
  const route = getRoute()
  const req = Readable.from([Buffer.from('{not json', 'utf8')])
  req.method = 'POST'
  const res = { statusCode: 0, headers: {}, headersSent: false, body: null, setHeader() {}, end(c) { this.body = c } }
  await route.handler(req, res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, 'invalid-body')
})

test('a non-POST method is refused', async () => {
  const { calls, getRoute } = mount(PATHS)
  const result = await request(getRoute(), { method: 'GET' })
  assert.equal(result.status, 405)
  assert.equal(calls.create, 0)
})

test('list without a sessionId is a business failure, and GET is a 405', async () => {
  const { getRoute } = mount(PATHS)
  const route = getRoute('/side-assistant/list')
  const missing = await request(route, { body: {} })
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.error, 'missing-session-id')
  const wrongMethod = await request(route, { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
})

test('preload composes an assistant before the press, and the press reuses it', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  const warmed = await request(getRoute('/side-assistant/preload'), { body: { sessionId: 's1' } })
  assert.equal(warmed.json.ok, true)
  assert.equal(warmed.json.created, true)
  assert.equal(calls.create, 1)
  // The framework lists a Session the moment it is created; the fake lists only
  // what a test puts there, so the warmed child is registered by hand.
  ctx.sessionQuery.records.push(detached(warmed.json.childId))

  // The press finds the warmed Session and composes nothing new.
  const pressed = await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(pressed.json.childId, warmed.json.childId)
  assert.equal(pressed.json.created, false)
  assert.equal(calls.create, 1)
})

test('preload refuses a Session with no resident agent, and composes nothing', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  ctx.agents.live = false
  const warmed = await request(getRoute('/side-assistant/preload'), { body: { sessionId: 's1' } })
  assert.equal(warmed.json.ok, true)
  assert.equal(warmed.json.skipped, 'parent-not-live')
  assert.equal(calls.create, 0)
})

test('preload can be turned off in the row config', async () => {
  const { calls, getRoute } = mount({ preload: false })
  const warmed = await request(getRoute('/side-assistant/preload'), { body: { sessionId: 's1' } })
  assert.equal(warmed.json.ok, true)
  assert.equal(warmed.json.skipped, 'disabled')
  assert.equal(calls.create, 0)
})

test('preload needs a sessionId and a POST', async () => {
  const { getRoute } = mount(PATHS)
  const missing = await request(getRoute('/side-assistant/preload'), { body: {} })
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.error, 'missing-session-id')
  const wrongMethod = await request(getRoute('/side-assistant/preload'), { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
})

/** One parent event, as `session/event` delivers it. */
function parentEvent(type, seq, data) {
  return { type, seq, data, time: 1792150000000 + seq }
}

/** The compact stream of one assistant step: reasoning first, then the answer. */
function stepStream({ thought, text }) {
  return [
    { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1], texts: [thought] },
    { type: 'text-chunks', time0: 3, index: 1, dt: [], texts: [text] },
  ]
}

/** A live child agent the Host half can attach the digest to. */
function resumable(childId) {
  const attached = []
  return {
    attached,
    agent: {
      id: childId,
      ctx: {
        systemPrompt: {
          context(registered) {
            attached.push(registered)
          },
        },
      },
    },
  }
}

test('a parent step becomes prompt context, not a transcript message', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const before = calls.childSession.appended.length

  ctx.emit('session/event', { id: 's1' }, parentEvent('turn/start', 1, { turn: 1 }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/call', 2, { callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/result', 3, { callId: 'c1', isError: false }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 4, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '先看看目录里有什么', text: '目录里有一个 a.md' }),
  }))

  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  assert.equal(live.attached.length, 1)
  assert.equal(live.attached[0].name, 'side-assistant:progress')
  assert.equal(live.attached[0].order, 125)
  const text = live.attached[0].text
  assert.match(text, /先看看目录里有什么/)
  assert.match(text, /did: bash: \{"command":"ls -la"\} \(done\)/)
  assert.match(text, /目录里有一个 a\.md/)
  // The digest is prompt context: nothing was written into the child's log.
  assert.equal(calls.childSession.appended.length, before)
  assert.equal(calls.childSession.appended.some((entry) => String(entry.type).includes('message')), false)
})

test('a block leads with a one-sentence conclusion, then tools, then thoughts', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/call', 1, { callId: 'c1', name: 'read', arguments: '{"path":"a.md"}' }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/result', 2, { callId: 'c1', isError: false }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 3, {
    turn: 1,
    step: 7,
    stream: stepStream({ thought: 'Read the file to the end.', text: 'Already read a.md. Next, edit b.js.' }),
  }))

  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const text = live.attached[0].text

  const head = text.indexOf('[step 7]')
  const conclusion = text.indexOf('Conclusion: Already read a.md')
  const tool = text.indexOf('did: read: {"path":"a.md"} (done)')
  const thought = text.indexOf('thought: Read the file to the end.')
  assert.ok(head !== -1 && conclusion > head, 'the block starts with its conclusion')
  assert.ok(tool > conclusion, 'tools come after the conclusion')
  assert.ok(thought > tool, 'raw thoughts come last')
  // Only the first sentence survives; the rest of the step is not quoted back.
  assert.doesNotMatch(text, /Next, edit b\.js/)
})

test('several blocks are laid out oldest first and the instruction walks them in order', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  for (const [seq, step] of [[1, 5], [2, 7]]) {
    ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', seq, {
      turn: 1,
      step,
      stream: stepStream({ thought: `thinking of step ${step}`, text: `Finished step ${step}.` }),
    }))
  }

  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const text = live.attached[0].text
  const older = text.indexOf('[step 5]')
  const newer = text.indexOf('[step 7]')
  assert.ok(older !== -1 && newer !== -1)
  assert.ok(older < newer, 'blocks stay in the order the steps ran')
  assert.match(text, /oldest to newest, one sentence each/)
})

test('the digest re-reads itself at every assembly, so a later step shows up', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  assert.equal(live.attached[0].text, '')

  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 9, {
    turn: 2,
    step: 1,
    stream: stepStream({ thought: '现在改文件', text: '改好了' }),
  }))
  assert.match(live.attached[0].text, /现在改文件/)
})

test('the digest keeps the newest blocks, bounded', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  for (let step = 1; step <= 9; step += 1) {
    ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', step, {
      turn: 1,
      step,
      stream: stepStream({ thought: `thinking of step ${step}`, text: `answer of step ${step}` }),
    }))
  }
  const text = live.attached[0].text
  assert.equal((text.match(/\[step \d+\]/g) ?? []).length, 4)
  assert.doesNotMatch(text, /thinking of step 1\b/)
  assert.match(text, /thinking of step 9\b/)
})

test('events of another Session never reach an assistant', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  ctx.emit('session/event', { id: 's2' }, parentEvent('assistant/message', 1, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '别的会话', text: '不该出现' }),
  }))
  assert.equal(live.attached[0].text, '')
})

test('the menu adopts an assistant that predates a Host restart', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-old', { createdAt: Date.now() - 5000 }))
  await request(getRoute('/side-assistant/list'), { body: { sessionId: 's1' } })
  const live = resumable('child-old')
  ctx.emit('agent/created', { agent: live.agent })
  assert.equal(live.attached.length, 1)
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 1, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '重启之后的新进展', text: '好了' }),
  }))
  assert.match(live.attached[0].text, /重启之后的新进展/)
})

test('a restored pane adopts its assistant from the startup scan', async () => {
  const { ctx, calls } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-restored', { createdAt: Date.now() - 1000 }))
  // The scan is kicked off by apply(); wait for it the way a real announcement would.
  await ctx.emit('agent/created', { agent: resumable('child-restored').agent })
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 1, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '重启后还在推进', text: '好了' }),
  }))
  const live = resumable('child-restored')
  await ctx.emit('agent/created', { agent: live.agent })
  assert.equal(live.attached.length, 1)
  assert.match(live.attached[0].text, /重启后还在推进/)
  assert.equal(calls.create, 0)
})

test('a real delegation is never adopted', async () => {
  const { ctx } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-delegated', { createdAt: Date.now() - 1000 }))
  // `subagents.listChildren` is the catalog the scan subtracts.
  ctx.subagents.children.push({ id: 'child-delegated' })
  const live = resumable('child-delegated')
  await ctx.emit('agent/created', { agent: live.agent })
  assert.equal(live.attached.length, 0)
})

test('a thought that looks like a prompt variable cannot break the step', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 1, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '是不是要填 {{conversation_id}}？', text: '问了' }),
  }))
  // The framework interpolates `{{name}}`; an unknown one aborts the step, so the
  // digest must not contain a live reference.
  assert.doesNotMatch(live.attached[0].text, /\{\{conversation_id\}\}/)
  assert.match(live.attached[0].text, /是不是要填/)
})

test('a refused creation leaves no digest behind', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.agents.create = async () => {
    throw new Error('no usable cwd')
  }
  await request(getRoute(), { body: { sessionId: 's1' } })
  // Nothing was announced for the refused Session, so a fresh press must not
  // resurrect a half-built digest under the same id.
  const refused = resumable('whatever')
  ctx.emit('agent/created', { agent: refused.agent })
  assert.equal(refused.attached.length, 0)
})

test('a tool call without a result is still reported as pending', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/call', 1, { callId: 'c9', name: 'grep', arguments: '{"pattern":"x"}' }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 2, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '搜一下', text: '在搜' }),
  }))
  assert.match(live.attached[0].text, /grep/)
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}`)
    console.log(`      ${error.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
