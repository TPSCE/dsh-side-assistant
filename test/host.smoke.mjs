/**
 * Host-half smoke test for `side-assistant`.
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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply, inject } from '../index.js'

const PATHS = {
  label: '侧边助手',
}

/** The progress context among a live Session's attached prompt contexts. */
function progressOf(live) {
  return live.attached.find((item) => item.name === 'side-assistant:progress')
}

/**
 * Point the plugin's settings store at a throwaway `DSH_HOME` for one test.
 *
 * The real path is read on every mount, so swapping the variable here keeps the
 * settings tests from writing into the developer's own profile.
 * @returns the directory the test may inspect.
 */
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sa-home-'))
  process.env.DSH_HOME = home
  return home
}

/** The settings document the plugin would have written, as saved on disk. */
function storedSettings(home) {
  return JSON.parse(readFileSync(join(home, 'storages', 'side-assistant', 'settings.json'), 'utf8'))
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
    listDescendants: 0,
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
      /** Other Sessions a test wants readable, keyed by id (a subagent's log). */
      bySession: new Map(),
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
        const own = ctx.sessionQuery.bySession.get(sessionId)
        return { header: { id: sessionId }, events: own ?? ctx.sessionQuery.events }
      },
    },
    subagents: {
      children: [],
      /** Recursive catalog rows a subagent test wants listed. */
      descendants: [],
      async listChildren(parentSessionId, signal) {
        calls.listChildren += 1
        assert.equal(typeof parentSessionId, 'string')
        assert.ok(signal instanceof AbortSignal, 'listChildren must receive the lifetime signal')
        return ctx.subagents.children
      },
      async listDescendants(rootSessionId, signal) {
        calls.listDescendants += 1
        assert.equal(rootSessionId, parent.session.header.id)
        return ctx.subagents.descendants
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

test('registers the five exact routes, the progress watchers and one lifetime effect', () => {
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
  const settings = getRoute('/side-assistant/settings')
  assert.equal(settings.kind, 'exact')
  assert.equal(typeof settings.handler, 'function')
  const ping = getRoute('/side-assistant/ping')
  assert.equal(ping.kind, 'exact')
  assert.equal(typeof ping.handler, 'function')
  assert.deepEqual([...routes.keys()], [
    '/side-assistant/ensure',
    '/side-assistant/list',
    '/side-assistant/preload',
    '/side-assistant/settings',
    '/side-assistant/ping',
  ])
  assert.deepEqual(effectLabels, [
    'side-assistant: progress on agent/created',
    'side-assistant: progress on session/event',
    'side-assistant: adopt existing progress',
    'side-assistant: lifetime',
    'side-assistant: /side-assistant/ensure',
    'side-assistant: /side-assistant/list',
    'side-assistant: /side-assistant/preload',
    'side-assistant: /side-assistant/settings',
    'side-assistant: /side-assistant/ping',
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

test('an assistant opened mid-turn folds the steps that turn already finished', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  ctx.sessionQuery.events = [
    { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先前那个回合' }] } },
    {
      type: 'assistant/message',
      seq: 1,
      data: { turn: 1, step: 1, stream: stepStream({ thought: '旧想法', text: '先前那个回合的回答' }) },
    },
    { type: 'turn/end', seq: 2 },
    // The turn running right now, and both steps finished before the child existed.
    {
      type: 'assistant/message',
      seq: 3,
      data: { turn: 2, step: 1, stream: stepStream({ thought: '先看看现状', text: '先读一下 README' }) },
    },
    {
      type: 'assistant/message',
      seq: 4,
      data: { turn: 2, step: 2, stream: stepStream({ thought: '然后动手', text: '改 client.js' }) },
    },
  ]

  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  const text = progressOf(live).text
  assert.match(text, /先读一下 README/, 'the step that finished before creation is in the index')
  assert.match(text, /改 client\.js/, 'so is the newer one')
  const digest = live.attached.find((entry) => entry.name === 'side-assistant:history')
  assert.doesNotMatch(digest.text, /先读一下 README/, 'the running turn stays out of the written summary')
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
  const tools = new Map()
  const toolNames = []
  return {
    attached,
    tools,
    toolNames,
    agent: {
      id: childId,
      ctx: {
        systemPrompt: {
          context(registered) {
            attached.push(registered)
          },
        },
        // The tool layer a real `agent.ctx` exposes: registering here lands in
        // that agent's own scope, which is exactly what the plugin relies on.
        get(name) {
          if (name !== 'tools') return undefined
          return {
            register(definition) {
              toolNames.push(definition.name)
              tools.set(definition.name, definition)
              return () => {
                tools.delete(definition.name)
              }
            },
          }
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

  assert.equal(live.attached.filter((item) => item.name === 'side-assistant:progress').length, 1)
  assert.equal(progressOf(live).name, 'side-assistant:progress')
  assert.equal(progressOf(live).order, 125)
  const text = progressOf(live).text
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
  const text = progressOf(live).text

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
  const text = progressOf(live).text
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
  assert.equal(progressOf(live).text, '')

  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 9, {
    turn: 2,
    step: 1,
    stream: stepStream({ thought: '现在改文件', text: '改好了' }),
  }))
  assert.match(progressOf(live).text, /现在改文件/)
})

test('the newest steps keep their detail while older ones become one line each', async () => {
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
  const text = progressOf(live).text
  // Five newest steps keep tools and reasoning; the four before them survive as headlines.
  assert.match(text, /Newest steps \(in full, oldest first\):/)
  assert.equal((text.match(/thought: thinking of step/g) ?? []).length, 5)
  assert.match(text, /thinking of step 9\b/)
  assert.doesNotMatch(text, /thinking of step 4\b/)
  assert.match(text, /Step index \(one line each, oldest first\):/)
  for (const step of [1, 2, 3, 4]) assert.match(text, new RegExp(`\\[step ${step}\\] answer of step ${step}`))
  const earlier = text.indexOf('Step index')
  const newest = text.indexOf('Newest steps')
  assert.ok(earlier !== -1 && newest > earlier, 'the one-line list comes before the full blocks')
})

test('an index line names the tools and targets, not just the conclusion', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  // One step with two tool calls: the exact case a prose summary used to lose.
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/call', 1, {
    name: 'bash',
    callId: 'c1',
    arguments: { command: 'node test/host.smoke.mjs' },
  }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/result', 2, { message: { callId: 'c1' } }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/call', 3, {
    name: 'edit',
    callId: 'c2',
    arguments: { path: 'client.js' },
  }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('tool/result', 4, { message: { callId: 'c2' }, error: 'boom' }))
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 5, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '改一下按钮', text: '加了删除按钮，测试挂了。' }),
  }))
  // Six more steps push step 1 out of the detailed window, into the index.
  for (let step = 2; step <= 7; step += 1) {
    ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', step + 4, {
      turn: 1,
      step,
      stream: stepStream({ thought: `thinking of step ${step}`, text: `answer of step ${step}` }),
    }))
  }
  const text = progressOf(live).text
  const line = text.split('\n').find((item) => item.includes('[step 1]')) ?? ''
  assert.match(line, /bash:node test\/host\.smoke\./, 'the target is named, clipped to the index budget')
  assert.match(line, /edit:client\.js/) 
  assert.match(line, /✗/, 'a failed call is marked')
  assert.match(line, /加了删除按钮/, 'the conclusion rides along')
})

test('the prompt lists the main session’s jobs, and the tail tool reads one', async () => {
  const { ctx, calls, services, getRoute } = mount(PATHS)
  const reads = []
  const now = Date.now()
  services.jobs = {
    list(sessionId) {
      assert.equal(sessionId, 's1', 'the job list is fenced to the main session')
      return [
        { id: 'bash-3', kind: 'bash', label: 'npm test', status: 'running', progress: '2/5', startedAt: now - 120000 },
        { id: 'bash-2', kind: 'bash', label: 'pnpm build', status: 'completed', detail: 'exit code: 0', startedAt: now - 600000, finishedAt: now - 540000 },
        { id: 'bash-1', kind: 'bash', label: 'ancient command', status: 'completed', detail: 'exit code: 0', startedAt: now - 7200000, finishedAt: now - 7100000 },
      ]
    },
    get(id, sessionId) {
      assert.equal(sessionId, 's1')
      return { id, status: 'running' }
    },
    readAt(id, from, sessionId) {
      reads.push({ id, from, sessionId })
      return { chunks: [{ text: 'line 1\n' }, { text: 'line 2\n' }], next: 14, lossy: false }
    },
  }
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  const jobs = live.attached.find((entry) => entry.name === 'side-assistant:jobs')
  assert.ok(jobs !== undefined, 'the job list is attached to the child')
  assert.equal(jobs.order, 122, 'between the history summary and the progress blocks')
  const text = jobs.text
  assert.match(text, /bash-3\s+running\s+npm test\s+2\/5/, 'a running job names what it runs and how far')
  assert.match(text, /bash-2\s+completed\s+pnpm build/, 'a job that settled recently stays listed')
  assert.doesNotMatch(text, /ancient command/, 'a job from an hour ago is old news')

  const tool = live.tools.get('side_assistant_read_job')
  assert.ok(tool !== undefined, 'the tail tool rides along')
  assert.equal(tool.parameters.required?.[0], 'job')
  const answer = await tool.execute({ job: 'bash-3' })
  assert.equal(answer.job, 'bash-3')
  assert.match(answer.text, /line 2/, 'the tail comes back')
  assert.deepEqual(reads, [{ id: 'bash-3', from: 0, sessionId: 's1' }], 'reads retained output, never the model cursor')
})

test('with no job registry, the prompt says nothing about jobs', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  assert.equal(live.attached.some((entry) => entry.name === 'side-assistant:jobs'), false)
  assert.deepEqual(live.toolNames, ['side_assistant_read_steps', 'side_assistant_read_subagent'], 'no job tool without a registry')
})

test('the drill-down tool answers for one step, and only in the child’s own tool layer', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  assert.deepEqual(live.toolNames, ['side_assistant_read_steps', 'side_assistant_read_subagent'], 'registered once, in the child scope')
  for (let step = 1; step <= 7; step += 1) {
    ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', step, {
      turn: 1,
      step,
      stream: stepStream({ thought: `thinking ${step}`, text: `answer of step ${step}` }),
    }))
  }
  const tool = live.tools.get('side_assistant_read_steps')
  assert.ok(tool.output?.render !== undefined, 'the registry contract requires a renderer')
  // `register()` hands `parameters` to the provider verbatim (only `defineTool`
  // compiles the property-map dialect), so a map here reaches the model as
  // `type: null` and the turn fails with "Invalid schema for function".
  assert.equal(tool.parameters?.type, 'object', 'parameters is object-rooted JSON Schema')
  assert.equal(tool.parameters.properties?.from?.type, 'integer')
  assert.equal(tool.parameters.properties?.query?.type, 'string')
  assert.ok(Array.isArray(tool.parameters.required), 'parameters.required is an array')
  // The registry validates `output.schema` as JSON Schema: `required` must be an
  // array of names there (unlike the parameter dialect's `required: true`), and a
  // wrong spelling only shows up as a thrown register, i.e. no tool at all.
  assert.ok(Array.isArray(tool.output.schema.required), 'output schema uses JSON Schema required')
  assert.deepEqual(tool.output.schema.required, ['text', 'steps'])
  assert.equal(tool.output.schema.type, 'object')

  const one = await tool.execute({ from: 2, to: 2 })
  assert.equal(one.steps, 1)
  assert.match(one.text, /\[step 2\]/)
  assert.match(one.text, /thought: thinking 2/)
  assert.match(one.text, /said: answer of step 2/)
  assert.doesNotMatch(one.text, /\[step 3\]/)

  const keyword = await tool.execute({ query: 'thinking 5' })
  assert.equal(keyword.steps, 1)
  assert.match(keyword.text, /\[step 5\]/)

  const quoted = await tool.execute({ from: '3', to: '3' })
  assert.equal(quoted.steps, 1, 'a step number the model quoted as a string still works')
  assert.match(quoted.text, /\[step 3\]/)

  const none = await tool.execute({ query: 'nothing like this' })
  assert.equal(none.steps, 0)
  assert.match(none.text, /Steps still kept: 1\.\.7/, 'it names the range it still holds')
})

test('the subagent tool lists what the parent spawned, one level deep by default', async () => {
  freshHome()
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const catalog = [
    { kind: 'child', id: 'sub-1111-aaaa', mode: 'continuable', activity: 'inactive', label: '检查设置页', depth: 1, parentId: 's1', hasChildren: true },
    { kind: 'child', id: 'sub-2222-bbbb', mode: 'continuable', activity: 'running', label: '改测试', depth: 2, parentId: 'sub-1111-aaaa', hasChildren: false },
    { kind: 'diagnostic', id: 'sub-3333-cccc', reason: 'unavailable' },
  ]
  ctx.subagents.descendants = catalog
  const tool = live.tools.get('side_assistant_read_subagent')
  assert.ok(tool !== undefined, 'the subagent tool is registered next to the drill-down')
  assert.equal(tool.parameters?.type, 'object', 'parameters is object-rooted JSON Schema')
  assert.equal(tool.parameters.properties?.subagent?.type, 'string')
  assert.equal(tool.parameters.properties?.depth?.maximum, 5, 'the schema allows the widest setting')
  assert.deepEqual(tool.output.schema.required, ['text', 'steps'])

  const signal = new AbortController().signal
  const listed = await tool.execute({}, { signal })
  assert.equal(listed.steps, 0)
  assert.match(listed.text, /检查设置页/, 'a direct child is listed with its label')
  assert.match(listed.text, /sub-1111/, 'and its id, so it can be addressed')
  assert.match(listed.text, /depth ≤ 1/, 'the shipped setting walks one level')
  assert.doesNotMatch(listed.text, /改测试/, 'depth 1 does not walk into grandchildren')
  assert.doesNotMatch(listed.text, /pass `depth:/, 'nothing to offer when the setting is 1')
  assert.match(listed.text, /unreadable/, 'a broken child catalog is reported, not hidden')

  // The setting decides how deep a call may go: raise it, and the same call
  // (no argument) now walks two levels without the model asking.
  const raised = await request(getRoute('/side-assistant/settings'), {
    body: { settings: { ...PATHS.settings, subagentDepth: 2 } },
  })
  assert.equal(raised.status, 200)
  const deeper = await tool.execute({}, { signal })
  assert.match(deeper.text, /depth ≤ 2/, 'the raised setting is what an argument-less call uses')
  assert.match(deeper.text, /改测试/, 'grandchildren are listed once the setting allows them')

  const clamped = await tool.execute({ depth: 9 }, { signal })
  assert.match(clamped.text, /depth ≤ 2/, 'a depth beyond the setting is clamped, never walked')
  const lower = await tool.execute({ depth: 1 }, { signal })
  assert.doesNotMatch(lower.text, /改测试/, 'the model can still narrow below the setting')
})

test('the depth setting is clamped into its own range', async () => {
  freshHome()
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const tool = live.tools.get('side_assistant_read_subagent')
  const signal = new AbortController().signal
  ctx.subagents.descendants = [
    { kind: 'child', id: 'sub-1111-aaaa', mode: 'continuable', activity: 'inactive', label: '检查设置页', depth: 1, parentId: 's1', hasChildren: true },
  ]
  const saved = await request(getRoute('/side-assistant/settings'), {
    body: { settings: { ...PATHS.settings, subagentDepth: 99 } },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.settings.subagentDepth, 5, 'a hand-set 99 lands on the ceiling')
  const answer = await tool.execute({}, { signal })
  assert.match(answer.text, /depth ≤ 5/)
  const broken = await request(getRoute('/side-assistant/settings'), {
    body: { settings: { ...PATHS.settings, subagentDepth: 0 } },
  })
  assert.equal(broken.json.settings.subagentDepth, 1, 'zero lands on the floor')
})

test('a subagent is read as its own steps, never as the parent’s', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  // The parent has steps of its own; a subagent read must not touch them.
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 1, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: 'parent thinking', text: 'parent answer' }),
  }))
  ctx.subagents.descendants = [
    { kind: 'child', id: 'sub-1111-aaaa', mode: 'continuable', activity: 'running', label: '检查设置页', depth: 1, parentId: 's1', hasChildren: false },
  ]
  ctx.sessionQuery.bySession.set('sub-1111-aaaa', [
    { type: 'tool/call', seq: 1, data: { callId: 'k1', name: 'read', arguments: '{"path":"settings.json"}' } },
    { type: 'tool/result', seq: 2, data: { callId: 'k1', isError: false } },
    {
      type: 'assistant/message',
      seq: 3,
      data: { turn: 1, step: 1, stream: stepStream({ thought: 'look at the file', text: 'The settings file exists.' }) },
    },
  ])
  const signal = new AbortController().signal
  const tool = live.tools.get('side_assistant_read_subagent')

  const answer = await tool.execute({ subagent: '检查设置页' }, { signal })
  assert.equal(answer.steps, 1)
  assert.match(answer.text, /Subagent `检查设置页` \(sub-1111, running, depth 1\)/)
  assert.match(answer.text, /did: read: \{"path":"settings.json"\} \(done\)/)
  assert.match(answer.text, /said: The settings file exists\./)
  assert.doesNotMatch(answer.text, /parent answer/, 'the parent log is not what a child read returns')

  const prefix = await tool.execute({ subagent: 'sub-11' }, { signal })
  assert.equal(prefix.steps, 1, 'an id prefix addresses the same child')

  const narrowed = await tool.execute({ subagent: 'sub-1111-aaaa', query: 'nothing like this' }, { signal })
  assert.equal(narrowed.steps, 0)
  assert.match(narrowed.text, /Steps still kept: 1\.\.1/, 'the answer still names the range the child holds')

  const unknown = await tool.execute({ subagent: 'nope' }, { signal })
  assert.equal(unknown.steps, 0)
  assert.match(unknown.text, /No subagent matches/)
  assert.match(unknown.text, /Known: sub-1111 \(检查设置页\)/)
})

test('with no subagents spawned, the tool says so instead of inventing one', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const tool = live.tools.get('side_assistant_read_subagent')
  const empty = await tool.execute({}, { signal: new AbortController().signal })
  assert.equal(empty.steps, 0)
  assert.match(empty.text, /has not spawned a subagent/)
  assert.equal(calls.listDescendants, 1)
})

test('the timeline is bounded on characters, oldest lines leaving first', async () => {
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })

  for (let step = 1; step <= 300; step += 1) {
    ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', step, {
      turn: 1,
      step,
      stream: stepStream({ thought: `thinking ${step}`, text: `long answer of step ${step} `.padEnd(160, 'x') }),
    }))
  }
  const text = progressOf(live).text
  assert.ok(text.length < 20000, `the digest stays bounded, got ${text.length}`)
  assert.match(text, /\[step 300\]/)
  assert.doesNotMatch(text, /answer of step 1\b/)
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
  assert.equal(progressOf(live).text, '')
})

test('the menu adopts an assistant that predates a Host restart', async () => {
  const { ctx, getRoute } = mount(PATHS)
  ctx.sessionQuery.records.push(detached('child-old', { createdAt: Date.now() - 5000 }))
  await request(getRoute('/side-assistant/list'), { body: { sessionId: 's1' } })
  const live = resumable('child-old')
  ctx.emit('agent/created', { agent: live.agent })
  assert.equal(live.attached.filter((item) => item.name === 'side-assistant:progress').length, 1)
  ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', 1, {
    turn: 1,
    step: 1,
    stream: stepStream({ thought: '重启之后的新进展', text: '好了' }),
  }))
  assert.match(progressOf(live).text, /重启之后的新进展/)
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
  assert.equal(live.attached.filter((item) => item.name === 'side-assistant:progress').length, 1)
  assert.match(progressOf(live).text, /重启后还在推进/)
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
  assert.doesNotMatch(progressOf(live).text, /\{\{conversation_id\}\}/)
  assert.match(progressOf(live).text, /是不是要填/)
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
  assert.match(progressOf(live).text, /grep/)
})


// ---- settings board (v0.12.0) ----

test('the settings route answers the shipped document with no secret in it', async () => {
  freshHome()
  const { getRoute } = mount(PATHS)
  const result = await request(getRoute('/side-assistant/settings'), { method: 'GET' })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.limits, { steps: [1, 50], tokens: [500, 200000], subagentDepth: [1, 5] })
  assert.equal(result.json.settings.label, PATHS.label)
  assert.equal(result.json.settings.opener, 'hello')
  assert.equal(result.json.settings.steps, 5)
  assert.equal(result.json.settings.tokens, 2000)
  assert.equal(result.json.settings.subagentDepth, 1, 'one level out of the box')
  assert.equal(result.json.settings.style, 'brief')
  assert.equal(result.json.settings.modelMode, 'inherit')
  assert.equal(result.json.keyConfigured, false)
  assert.equal('apiKey' in result.json.settings, false)
})

test('the settings route takes GET and POST only', async () => {
  freshHome()
  const { getRoute } = mount(PATHS)
  const result = await request(getRoute('/side-assistant/settings'), { method: 'PUT' })
  assert.equal(result.status, 405)
  assert.equal(result.json.error, 'method-not-allowed')
})

test('a saved document survives a Host restart and drives the next composition', async () => {
  const home = freshHome()
  const first = mount(PATHS)
  const saved = await request(first.getRoute('/side-assistant/settings'), {
    body: {
      settings: {
        label: '小助手',
        opener: '早上好',
        modelMode: 'inherit',
        steps: 1,
        tokens: 1000,
        style: 'detailed',
      },
    },
  })
  assert.equal(saved.json.ok, true)
  assert.equal(saved.json.settings.label, '小助手')
  assert.equal(storedSettings(home).steps, 1)

  // A fresh mount is a Host restart: no memory of the save, only the file.
  const second = mount(PATHS)
  const press = await request(second.getRoute(), { body: { sessionId: 's1' } })
  assert.equal(press.json.ok, true)
  assert.equal(descriptorOf(second.calls).data.label, '小助手')
  assert.equal(second.calls.lastMessage.content[0].text, '早上好')

  // One full step is all the settings allow; the step before it becomes one line.
  const live = resumable(second.calls.lastCreate.sessionId)
  second.ctx.emit('agent/created', { agent: live.agent })
  for (const step of [1, 2]) {
    second.ctx.emit('session/event', { id: 's1' }, parentEvent('assistant/message', step, {
      turn: 1,
      step,
      stream: stepStream({ thought: `thinking of step ${step}`, text: `answer of step ${step}` }),
    }))
  }
  const text = progressOf(live).text
  assert.equal((text.match(/thought: thinking of step/g) ?? []).length, 1)
  assert.match(text, /\[step 1\] answer of step 1/)
  assert.match(text, /thought: thinking of step 2/)
})

test('an out-of-range document is clamped field by field, not rejected', async () => {
  freshHome()
  const { getRoute } = mount(PATHS)
  const saved = await request(getRoute('/side-assistant/settings'), {
    body: { settings: { steps: 999, tokens: 1, style: 'poetic', label: '   ' } },
  })
  assert.equal(saved.json.ok, true)
  assert.equal(saved.json.settings.steps, 50)
  assert.equal(saved.json.settings.tokens, 500)
  assert.equal(saved.json.settings.style, 'brief')
  assert.equal(saved.json.settings.label, PATHS.label)
})

test('an API key is stored through credentials and never echoed back', async () => {
  const home = freshHome()
  const { getRoute, services } = mount(PATHS)
  const stored = []
  services.settings = {
    describe() { return [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }] },
    async update() {},
  }
  services.credentials = {
    async set(ref, value) {
      stored.push([ref, value])
    },
    async resolve(ref) {
      const hit = stored.find(([name]) => name === ref)
      return hit === undefined ? undefined : { value: hit[1] }
    },
  }
  const saved = await request(getRoute('/side-assistant/settings'), {
    body: {
      settings: {
        modelMode: 'custom',
        custom: { baseURL: 'https://api.example.com/v1', model: 'my-model', apiKeyEnv: 'SIDE_ASSISTANT_API_KEY' },
      },
      apiKey: 'sk-test',
    },
  })
  assert.deepEqual(stored, [['SIDE_ASSISTANT_API_KEY', 'sk-test']])
  assert.equal(saved.json.keyConfigured, true)
  assert.equal(JSON.stringify(saved.json).includes('sk-test'), false)
  assert.equal(storedSettings(home).custom.baseURL, 'https://api.example.com/v1')
})

test('a custom endpoint is published as a pi-ai provider and used by the child', async () => {
  freshHome()
  const { getRoute, services, calls } = mount(PATHS)
  const updates = []
  services.settings = {
    describe() {
      return [{
        ns: 'llm-pi-ai',
        revision: 7,
        value: { providers: { deepseek: { displayName: 'DeepSeek' } } },
      }]
    },
    async update(ns, patch, revision) {
      updates.push({ ns, patch, revision })
    },
  }
  const saved = await request(getRoute('/side-assistant/settings'), {
    body: {
      settings: {
        modelMode: 'custom',
        custom: { baseURL: 'https://api.example.com/v1', model: 'my-model', apiKeyEnv: 'SIDE_ASSISTANT_API_KEY' },
      },
    },
  })
  assert.equal(saved.json.ok, true)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].ns, 'llm-pi-ai')
  assert.equal(updates[0].revision, 7)
  const profile = updates[0].patch.providers['side-assistant-custom']
  assert.equal(profile.baseURL, 'https://api.example.com/v1')
  assert.deepEqual(profile.models, [{ id: 'my-model' }])
  assert.equal(profile.apiKeyEnv, 'SIDE_ASSISTANT_API_KEY')
  assert.deepEqual(Object.keys(updates[0].patch.providers).sort(), ['deepseek', 'side-assistant-custom'])

  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.lastCreate.agentOptions.provider, 'side-assistant-custom')
  assert.equal(calls.lastCreate.agentOptions.model, 'my-model')
})

test('a custom endpoint without a base URL fails the save instead of half-writing', async () => {
  const home = freshHome()
  const { getRoute } = mount(PATHS)
  const saved = await request(getRoute('/side-assistant/settings'), {
    body: { settings: { modelMode: 'custom', custom: { baseURL: '', model: 'my-model' } } },
  })
  assert.equal(saved.json.ok, false)
  assert.equal(saved.json.error, 'missing-endpoint')
  assert.throws(() => storedSettings(home))
})

test('host mode names the route the child runs', async () => {
  freshHome()
  const { getRoute, calls } = mount(PATHS)
  await request(getRoute('/side-assistant/settings'), {
    body: { settings: { modelMode: 'host', provider: 'deepseek', model: 'deepseek-reasoner' } },
  })
  await request(getRoute(), { body: { sessionId: 's1' } })
  assert.equal(calls.lastCreate.agentOptions.provider, 'deepseek')
  assert.equal(calls.lastCreate.agentOptions.model, 'deepseek-reasoner')
})

test('the ping route spends a few tokens to prove the route really works', async () => {
  freshHome()
  const { getRoute, services } = mount(PATHS)
  services.settings = {
    describe() { return [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }] },
    async update() {},
  }
  await request(getRoute('/side-assistant/settings'), {
    body: { settings: { modelMode: 'host', provider: 'deepseek', model: 'deepseek-chat' } },
  })
  const asked = []
  services.llm = {
    stream(options) {
      asked.push(options)
      return (async function* relay() {
        yield { type: 'text-delta', text: 'pong' }
      })()
    },
  }
  const result = await request(getRoute('/side-assistant/ping'), { body: {} })
  assert.equal(result.json.ok, true)
  assert.equal(result.json.provider, 'deepseek')
  assert.equal(result.json.model, 'deepseek-chat')
  assert.equal(result.json.text, 'pong')
  assert.equal(typeof result.json.ms, 'number')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].maxTokens <= 32, true)
})

test('a failed test call is reported with its own message, not as a crash', async () => {
  freshHome()
  const { getRoute, services } = mount(PATHS)
  services.settings = {
    describe() { return [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }] },
    async update() {},
  }
  await request(getRoute('/side-assistant/settings'), {
    body: { settings: { modelMode: 'host', provider: 'deepseek', model: 'deepseek-chat' } },
  })
  services.llm = {
    stream() {
      return (async function* relay() {
        throw new Error('401 unauthorized')
      })()
    },
  }
  const result = await request(getRoute('/side-assistant/ping'), { body: {} })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'request-failed')
  assert.match(result.json.message, /401 unauthorized/)
})

test('a ping with no route says so instead of guessing one', async () => {
  freshHome()
  const { getRoute } = mount(PATHS)
  const result = await request(getRoute('/side-assistant/ping'), { body: {} })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'no-route')
})

test('the answer style reaches the child as its own prompt fragment', async () => {
  freshHome()
  const { ctx, calls, getRoute } = mount(PATHS)
  await request(getRoute('/side-assistant/settings'), {
    body: { settings: { style: 'detailed' } },
  })
  await request(getRoute(), { body: { sessionId: 's1' } })
  const live = resumable(calls.lastCreate.sessionId)
  ctx.emit('agent/created', { agent: live.agent })
  const style = live.attached.find((item) => item.name === 'side-assistant:style')
  assert.ok(style, 'the style fragment is attached')
  assert.equal(style.order, 118)
  assert.match(style.text, /Answer style: detailed/)
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
