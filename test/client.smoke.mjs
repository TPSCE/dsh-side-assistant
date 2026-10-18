/**
 * Browser-half smoke test for `side-assistant`.
 *
 * Stubs the module loader, React, DOM and fetch, then runs the real factory and
 * the real `apply()`. It verifies the things that silently break a UI plugin:
 * the slot registration shapes, the resource address it hands the sidebar, and
 * the pane's progress strip — including the follow stream it rewrites into
 * rows. It renders no React tree on purpose (a hook runtime, not a rastrerizer;
 * no DOM emulator beyond what `apply` itself touches).
 *
 * Run: node test/client.smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

/** ------------------------------------------------------------------ stubs */

let registration = null
const domListeners = new Map()
globalThis.window = {
  innerWidth: 1280,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load(value) {
      assert.equal(registration, null, 'the bundle must register exactly one factory')
      registration = value
    },
  },
}

const styleTags = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', parentNode: null }),
  addEventListener(type, handler) {
    domListeners.set(type, handler)
  },
  removeEventListener(type) {
    domListeners.delete(type)
  },
  head: {
    appendChild(tag) {
      styleTags.push(tag)
      tag.parentNode = { removeChild: () => {} }
    },
  },
}

/**
 * Hook runtime for the components under test.
 *
 * Slots persist across passes and the cursor resets, which is how React
 * identifies hooks too. Effects run when their dependencies change (Object.is
 * per entry), so a `[]` effect runs once and an `[open]` effect re-runs on the
 * toggle — enough to press a rendered button, settle async state, and observe
 * what the next render looks like.
 */
let hookSlots = []
let hookCursor = 0
let pendingEffects = []
let hookDirty = false

const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index]))

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
      hookDirty = true
    }
  },
  useRef(initial) {
    const index = hookCursor++
    hookSlots[index] ??= { ref: { current: initial } }
    return hookSlots[index].ref
  },
  useState(initial) {
    const index = hookCursor++
    hookSlots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
    const slot = hookSlots[index]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      hookDirty = true
    }]
  },
  useCallback: (fn) => fn,
  useEffect: (fn, deps) => {
    const index = hookCursor++
    const slot = hookSlots[index] ??= {}
    if (slot.deps !== undefined && sameDeps(slot.deps, deps)) return
    slot.deps = deps
    slot.fn = fn
    pendingEffects.push(slot)
  },
  useLayoutEffect: (fn, deps) => {
    const index = hookCursor++
    const slot = hookSlots[index] ??= {}
    if (slot.deps !== undefined && sameDeps(slot.deps, deps)) return
    slot.deps = deps
    slot.fn = fn
    pendingEffects.push(slot)
  },
}

await import('../client.js')

/** ------------------------------------------------------------- assertions */

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('registers a factory whose id is the package name', () => {
  assert.ok(registration, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(registration.id, manifest.name)
  assert.equal(typeof registration.factory, 'function')
})

const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected require(${specifier}) — declare it in dsh.client.external`)
})

test('returns { inject, apply } with no default export', () => {
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject'])
  assert.deepEqual(plugin.inject, ['slots', 'sidebarRight', 'sessions', 'remote', 'remote.session', 'locale'])
})

/** Mount the plugin against a fake Client Context. */
function mount() {
  const effects = []
  const injected = []
  const registered = []
  const resources = []
  const tabs = []
  const opened = []
  const retained = []
  const released = []
  const refreshes = []
  const services = {}
  const closed = []
  const archived = []
  /** Prompts the suggestion cards sent, and into which Session. */
  const sent = []
  let locale = null

  const ctx = {
    effect(execute, label) {
      effects.push(label)
      return execute()
    },
    inject(names, callback) {
      injected.push(names)
      return callback(ctx)
    },
    // `get` answers from the ctx itself as well: the plugin reaches for services
    // the Client registers on every context (`workspaces`, `sidebarRight`).
    get: (name) => services[name] ?? ctx[name],
    locale: {
      register(namespace, dictionaries) {
        locale = { namespace, dictionaries }
        return () => {}
      },
      bind(namespace) {
        return (key) => locale?.dictionaries?.zh?.[key] ?? key
      },
    },
    sessions: {
      refresh() {
        refreshes.push(retained.length)
        return Promise.resolve()
      },
      retain(target, options) {
        retained.push({ target, options })
        return { release: () => released.push(target) }
      },
      /** A session scope, the way the conversation plugin reaches `conversation`. */
      scope(sessionId) {
        return {
          get: (name) => (name === 'conversation'
            ? {
              async send(text) {
                sent.push({ sessionId, text })
              },
            }
            : undefined),
        }
      },
    },
    remote: {
      session: {
        follow() {
          throw new Error('this test did not install a follow stream')
        },
      },
    },
    resources: {
      register(provider) {
        resources.push(provider)
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(options) {
        tabs.push(options)
        return () => {}
      },
    },
    slots: {
      inject(ownerKey, callback) {
        injected.push(ownerKey)
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    sidebarRight: {
      openResource(address) {
        opened.push(address)
      },
      close(tabId) {
        closed.push(tabId)
      },
    },
    workspaces: {
      archiveSession(sessionId, options) {
        archived.push({ sessionId, options })
        return Promise.resolve()
      },
    },
  }

  plugin.apply(ctx)
  return {
    ctx,
    effects,
    injected,
    registered,
    resources,
    tabs,
    opened,
    retained,
    released,
    refreshes,
    services,
    closed,
    archived,
    sent,
    getLocale: () => locale,
    getHeaderAction: () => registered.find((entry) => entry.options.name === 'conversation.session.header.actions'),
    getPane: () => registered.find((entry) => entry.options.name === 'sidebar.right.pane.tab'),
  }
}

test('styles, trim, dictionaries, the panel and the header action are effects', () => {
  const mounted = mount()
  assert.deepEqual(mounted.effects, [
    'side-assistant: styles',
    'side-assistant: sidebar trim',
    'side-assistant: settings styles',
    'side-assistant: dictionaries',
    'side-assistant: chat resource',
    'side-assistant: chat tab type',
    'side-assistant: chat tab body',
    'side-assistant: suggestion cards',
    'side-assistant: header action',
    'side-assistant: settings section',
  ])
  assert.equal(styleTags.length, 3)
  assert.deepEqual(
    styleTags.map((tag) => tag.dataset.pluginCss),
    [
      'side-assistant/action.css',
      'side-assistant/sidebar-chat.css',
      'side-assistant/settings.css',
    ],
  )
})

test('the panel services are requested separately from the required ones', () => {
  const mounted = mount()
  assert.deepEqual(mounted.injected, [
    ['resources', 'sidebarRightTabs'],
    'sidebar.right.pane.tab',
    'conversation.input.dock',
    'conversation.session.header.actions',
    'settings.section',
  ])
})

test('the trim stylesheet is pane-scoped and hides the composer clutter', () => {
  mount()
  const trim = styleTags.find((tag) => tag.dataset.pluginCss === 'side-assistant/sidebar-chat.css')
  assert.ok(trim, 'the sidebar trim stylesheet must be installed')

  // Scan declarations only: comment prose must never be mistaken for a
  // selector, and the selector loop below keys off line shape.
  const css = trim.textContent.replace(/\/\*[\s\S]*?\*\//g, '')

  for (const slot of [
    'conversation.composer.dock',
    'conversation.input.attachments',
    'conversation.input.left',
    'conversation.input.right',
    'conversation.input.activity',
  ]) {
    assert.ok(
      css.includes(`[data-sidebar-chat] [data-slot="${slot}"]`),
      `expected the trim to hide ${slot}`,
    )
  }

  // The input dock carries the shortcut cards, so it must NOT be hidden as a
  // whole: only its other children are. Hiding the anchor would take the cards
  // with it — that is exactly how the cards went invisible once.
  assert.ok(
    !css.includes('[data-sidebar-chat] [data-slot="conversation.input.dock"] {'),
    'the input dock must not be hidden as a whole',
  )
  assert.ok(
    css.includes('[data-sidebar-chat] [data-slot="conversation.input.dock"] > *:not(:has(.dsh-sa-cards))'),
    'the dock must hide every child except the cards',
  )

  // The non-slot "+" button is anchored on the hidden file input it sits next to.
  assert.ok(css.includes('[data-sidebar-chat] div:has(> input[type="file"])'))

  // The assistant action row keeps copy / usage / clock only.
  assert.ok(
    css.includes('[data-sidebar-chat] [data-slot="conversation.chat.assistant-actions"]'),
    'the extension seat (feedback thumbs, context jump) must be hidden',
  )
  assert.ok(
    css.includes('[data-sidebar-chat] [data-actions-reveal] [data-clock] > button:last-of-type'),
    'the branch button must be hidden',
  )
  // ...and the branch rule must stay gated on the assistant-only marker, or it
  // would also hide the copy button on a user bubble's row.
  for (const line of css.split('\n')) {
    const selector = line.trim()
    if (!selector.endsWith('{') || !selector.includes('last-of-type')) continue
    assert.ok(
      selector.includes('[data-actions-reveal]'),
      `the branch rule needs the assistant-only gate: ${selector}`,
    )
  }

  // The placeholder is repainted, and only while the composer is usable.
  assert.ok(css.includes('[data-sidebar-chat] [data-composer-placeholder]'))
  assert.ok(css.includes('content: "ask anything～"'))
  assert.ok(
    css.includes(':has(> [data-placeholder][aria-disabled="true"])'),
    'the state placeholder must win over ours',
  )

  // Only the floor moves: the box starts one line tall and then grows exactly
  // like the main composer. A max-height, an overflow on the editor, or an
  // override of the shipped ceiling would turn a wrapped second line into
  // scrolling — the caret follows it and line 1 leaves a box that never grew.
  const editorAt = css.indexOf('[data-sidebar-chat] [data-composer-input]')
  assert.ok(editorAt !== -1, 'expected the one-line composer rule')
  const editorRule = css.slice(editorAt, css.indexOf('}', editorAt))
  assert.ok(editorRule.includes('min-height: 24px'), 'the floor is one line box')
  assert.ok(!editorRule.includes('max-height'), 'the box must grow past the first line')
  assert.ok(!editorRule.includes('overflow'), 'the editor must not clip its own lines')
  assert.ok(
    !css.includes('--dsh-composer-text-max-height'),
    'the shipped ceiling stays in charge of where growth stops',
  )
  assert.ok(
    !css.includes('[data-input-scroll]'),
    'the scroll wrapper keeps its own overflow: it is what scrolls at the ceiling',
  )

  // A running turn reads as one button, exactly like the main conversation.
  // A continuable subagent never gets the primary-to-Stop swap, so the shipped
  // composer leaves Send (disabled once the draft is submitted) beside a
  // separate Stop: hide the dead twin while it is disabled, and only then.
  const pairAt = css.indexOf(
    '[data-sidebar-chat] [data-composer-card] > div:last-child > div:last-child:has(> button + button)',
  )
  assert.ok(pairAt !== -1, 'expected the rule that collapses Stop plus Send into one button')
  const pairRule = css.slice(pairAt, css.indexOf('}', pairAt))
  assert.ok(
    pairRule.includes('> button:last-child[disabled]'),
    'only the disabled twin may hide: an enabled Send has work to do',
  )
  assert.ok(pairRule.includes('display: none'), 'the dead grey Send must leave the row')

  // Never leak into the main conversation: every selector line is scoped, except
  // the suggestion cards. The input dock is a conversation-wide slot, so those
  // rules must START hidden everywhere and be revealed by the pane-scoped rule —
  // a card rule that forgets the default would show up in every conversation.
  for (const line of css.split('\n')) {
    const selector = line.trim()
    const isSelector = selector.endsWith('{') || selector.endsWith(',')
    if (!isSelector) continue
    if (selector.startsWith('.dsh-sa-')) continue
    assert.ok(
      selector.includes('[data-sidebar-chat]'),
      `selector escapes the sidebar pane: ${selector}`,
    )
  }
  const cardsAt = css.indexOf('.dsh-sa-cards {')
  assert.ok(cardsAt !== -1, 'expected the default-hidden card wrapper')
  assert.ok(
    css.slice(cardsAt, css.indexOf('}', cardsAt)).includes('display: none'),
    'the cards must be invisible outside the pane',
  )
  const shownAt = css.indexOf('[data-sidebar-chat] .dsh-sa-cards {')
  assert.ok(shownAt !== -1, 'expected the pane-scoped reveal')
  assert.ok(
    css.slice(shownAt, css.indexOf('}', shownAt)).includes('display: flex'),
    'the reveal must lay the cards out',
  )
  assert.ok(css.includes('border-radius: var(--dsw-radius-lg)'), 'cards are rounded rectangles')
})

test('the pane root lays the strip above the chat', () => {
  mount()
  const sheet = styleTags.find((tag) => tag.dataset.pluginCss === 'side-assistant/action.css')
  const css = sheet.textContent
  // Our own tab body must establish the column the shipped chat fills, and it
  // must carry data-sidebar-chat itself: the trim above selects on it.
  assert.ok(css.includes('.side-assistant-pane {'))
  assert.ok(css.includes('flex-direction: column'))
  assert.ok(css.includes('.side-assistant-pane__chat {'))
  assert.ok(css.includes('.dsh-sa-progress'))
  assert.ok(css.includes('max-height: 148px'), 'the strip must not eat the pane')
  assert.ok(css.includes('overflow-y: auto'), 'the strip must scroll')
})

test('registers a chat tab type for this plugin’s own address', () => {
  const mounted = mount()
  assert.equal(mounted.tabs.length, 1)
  const tab = mounted.tabs[0]
  assert.equal(tab.id, 'side-assistant/chat')
  assert.equal(tab.kind, 'sideassistant')
  assert.deepEqual(tab.patterns, ['dsh-resource://sideassistant/chat/**'])
  assert.equal(tab.priority, 'builtin')
  assert.equal(tab.canOpen('dsh-resource://sideassistant/chat/C1?parent=S1'), true)
  // The shipped subagent chat keeps its own kind; ours must not claim it.
  assert.equal(tab.canOpen('dsh-resource://subagentchat/session/C1?parent=S1'), false)
  assert.equal(tab.canOpen(undefined), false)
  assert.equal(tab.title('dsh-resource://sideassistant/chat/C1?parent=S1'), '侧边助手')
})

test('registers the pane body against the shared chat seat', () => {
  const mounted = mount()
  const pane = mounted.getPane()
  assert.equal(pane.options.name, 'sidebar.right.pane.tab')
  assert.equal(pane.options.key, 'side-assistant/chat')
  assert.equal(pane.options.locale, 'sideAssistant')
  assert.deepEqual(pane.options.children, {
    'sidebar.chat.conversation': { kind: 'single', scope: 'session' },
  })
  assert.equal(pane.options.inject().remote, mounted.ctx.remote)
  assert.equal(typeof pane.component, 'function')
})

test('registers a resource provider for the chat protocol', () => {
  const mounted = mount()
  assert.equal(mounted.resources.length, 1)
  assert.equal(mounted.resources[0].protocol, 'sideassistant')
  assert.equal(typeof mounted.resources[0].open, 'function')
})

test('the chat resource retains the Session bound to the address', async () => {
  const mounted = mount()
  const provider = mounted.resources[0]
  const controller = new AbortController()
  const iterator = provider.open('dsh-resource://sideassistant/chat/C1?parent=S1', { signal: controller.signal })

  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.equal(first.value.ok, true)
  assert.deepEqual(first.value.value.address, { parentSessionId: 'S1', childSessionId: 'C1', mode: 'continuable' })
  // An address OBJECT is what makes `retain` skip the subagent catalog lookup —
  // the whole reason a detached Session can bind like any other.
  assert.deepEqual(mounted.retained, [{
    target: { parentSessionId: 'S1', childSessionId: 'C1', mode: 'continuable' },
    options: { source: 'sidebarChat', signal: controller.signal },
  }])

  controller.abort()
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.equal(mounted.released.length, 1, 'the reference is released when the pane closes')
})

test('the chat resource pulls the Session list before binding', async () => {
  const mounted = mount()
  const iterator = mounted.resources[0].open('dsh-resource://sideassistant/chat/C1?parent=S1', { signal: new AbortController().signal })
  const first = await iterator.next()
  assert.equal(first.value.ok, true)
  // A detached child sits in no catalog, so the client cannot tell from lineage
  // that it is not blank; the summary has to be pulled before the binding.
  assert.equal(mounted.refreshes.length, 1, 'the list is pulled once per open')
  assert.equal(mounted.refreshes[0], 0, 'the pull precedes the retain')
})

test('a failed list pull still binds the chat', async () => {
  const mounted = mount()
  mounted.ctx.sessions.refresh = () => Promise.reject(new Error('offline'))
  const iterator = mounted.resources[0].open('dsh-resource://sideassistant/chat/C1?parent=S1', { signal: new AbortController().signal })
  const first = await iterator.next()
  assert.equal(first.value.ok, true, 'the binding is not the list pull’s to fail')
})

test('a foreign or malformed address is refused', async () => {
  const mounted = mount()
  const provider = mounted.resources[0]
  for (const address of [
    'dsh-resource://subagentchat/session/C1?parent=S1&mode=continuable',
    'dsh-resource://sideassistant/chat/C1',
    'dsh-resource://sideassistant/chat/?parent=S1',
    undefined,
  ]) {
    const iterator = provider.open(address, { signal: new AbortController().signal })
    await assert.rejects(() => iterator.next(), /invalid chat resource address/, `${address} must be refused`)
  }
  assert.deepEqual(mounted.retained, [])
})

test('an already-cancelled open retains nothing', async () => {
  const mounted = mount()
  const controller = new AbortController()
  controller.abort()
  const iterator = mounted.resources[0].open('dsh-resource://sideassistant/chat/C1?parent=S1', { signal: controller.signal })
  const done = await iterator.next()
  assert.equal(done.done, true)
  assert.deepEqual(mounted.retained, [])
})

test('registers into the conversation header action list', () => {
  const mounted = mount()
  const { options, component } = mounted.getHeaderAction()
  assert.equal(options.name, 'conversation.session.header.actions')
  assert.equal(options.id, 'side-assistant')
  assert.equal(options.order, -15)
  assert.equal(options.locale, 'sideAssistant')
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof component, 'function')
})

test('the shortcut cards ride the input dock and send through the conversation', async () => {
  const mounted = mount()
  const entry = mounted.registered.find((row) => row.options.name === 'conversation.input.dock')
  assert.ok(entry, 'the cards must live in the input dock, under the transcript')
  assert.equal(entry.options.id, 'side-assistant-cards')
  assert.equal(entry.options.order, 30)
  assert.equal(entry.options.locale, 'sideAssistant')
  assert.equal(typeof entry.component, 'function')
  assert.equal(typeof entry.options.inject, 'function')

  const props = entry.options.inject('C1')
  assert.equal(typeof props.send, 'function')
  await props.send('这个项目是在干什么？')
  assert.deepEqual(mounted.sent, [{ sessionId: 'C1', text: '这个项目是在干什么？' }])
})

test('registers zh + en dictionaries under the declared namespace', () => {
  const mounted = mount()
  const locale = mounted.getLocale()
  assert.equal(locale.namespace, 'sideAssistant')
  assert.deepEqual(Object.keys(locale.dictionaries).sort(), ['en', 'zh'])
  assert.equal(locale.dictionaries.zh.label, '侧边助手')
  assert.equal(locale.dictionaries.zh.progress, '主 Agent 进展')
  assert.equal(locale.dictionaries.zh.askProject, '这个项目是在干什么？')
  assert.equal(locale.dictionaries.zh.askWork, 'agent 正在进行什么工作？')
})

test('the header warms a side assistant before the first press', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push([url, JSON.parse(init.body)])
    return json({ ok: true, childId: 'C-warm', created: true })
  }

  const session = renderAction('S-preload')
  session.draw()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(requests, [], 'nothing is warmed the instant the header appears')

  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(requests, [['/side-assistant/preload', { sessionId: 'S-preload' }]])

  // Redrawing the same Session does not ask twice.
  session.draw()
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(requests.length, 1)
  unmount()
})

test('opens the sidebar panel at this plugin’s own address', async () => {
  const mounted = mount()
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/side-assistant/ensure')
    assert.equal(init.method, 'POST')
    assert.deepEqual(JSON.parse(init.body), { sessionId: 'S1' })
    return { status: 200, json: async () => ({ ok: true, childId: 'C1', created: true }) }
  }

  await mounted.getHeaderAction().options.inject().openSideAssistant('S1')
  assert.deepEqual(mounted.opened, ['dsh-resource://sideassistant/chat/C1?parent=S1'])
})

test('a failed ensure throws instead of opening a broken tab', async () => {
  const mounted = mount()
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: false, error: 'session/not-found', message: '找不到会话 S9' }),
  })

  await assert.rejects(
    () => mounted.getHeaderAction().options.inject().openSideAssistant('S9'),
    /找不到会话 S9/,
  )
  assert.deepEqual(mounted.opened, [])
})

test('an unparseable response throws instead of opening a broken tab', async () => {
  const mounted = mount()
  globalThis.fetch = async () => ({
    status: 500,
    json: async () => { throw new Error('not json') },
  })

  await assert.rejects(
    () => mounted.getHeaderAction().options.inject().openSideAssistant('S9'),
    /HTTP 500/,
  )
  assert.deepEqual(mounted.opened, [])
})

/** ------------------------------------------- the header button, rendered */

const json = (payload) => ({ status: 200, json: async () => payload })

/** Stand-in for a mounted DOM node; `contains` compares identity. */
function fakeNode(node) {
  return {
    node,
    offsetWidth: 120,
    getBoundingClientRect: () => ({ left: 8 }),
    contains: (target) => target === node,
  }
}

/** Depth-first walk over elements (strings, nulls and booleans are leaves). */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node === null || typeof node !== 'object' || node.type === undefined) return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Every element under `tree` matching `predicate`. */
function collect(tree, predicate) {
  const found = []
  walk(tree, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

const isTrigger = (node) => node.props.className === 'side-assistant__action'
const isMenu = (node) => node.props.className === 'side-assistant__menu'
const isItem = (node) => typeof node.props.className === 'string'
  && node.props.className.includes('side-assistant__menu-item')
const menuLabels = (tree) => collect(tree, isItem).map((node) => node.children.join(''))

/** Settle one pass: render, attach refs, run the effects that changed. */
function pass(component, props) {
  hookCursor = 0
  pendingEffects = []
  hookDirty = false
  const tree = component(props)
  walk(tree, (node) => {
    const ref = node.props.ref
    if (ref && typeof ref === 'object' && 'current' in ref) ref.current = fakeNode(node)
  })
  for (const slot of pendingEffects) {
    if (typeof slot.cleanup === 'function') slot.cleanup()
    slot.cleanup = slot.fn()
  }
  return tree
}

/** Render passes until state settles. */
function draw(component, props) {
  let tree = null
  for (let round = 0; round < 8; round += 1) {
    tree = pass(component, props)
    if (!hookDirty) break
  }
  return tree
}

/** `draw`, but let promises (the follow stream) settle between passes. */
async function drawAsync(component, props) {
  let tree = null
  for (let round = 0; round < 8; round += 1) {
    tree = pass(component, props)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!hookDirty) break
  }
  return tree
}

/** Unmount the current tree: run every effect cleanup. */
function unmount() {
  for (const slot of hookSlots) {
    if (slot && typeof slot.cleanup === 'function') {
      slot.cleanup()
      slot.cleanup = undefined
    }
  }
}

/** Mount the button with a fake Client Context and its own hook slots. */
function renderAction(sessionId = 'S1') {
  const mounted = mount()
  const entry = mounted.getHeaderAction()
  // Run the previous tree's cleanups before dropping its slots: an effect may
  // own a timer (the preload ask), and a leaked one would fire into the next
  // test's `fetch` stub.
  unmount()
  hookSlots = []
  const dictionary = mounted.getLocale().dictionaries.zh
  const props = {
    sessionId,
    t: (key) => dictionary[key] ?? key,
    ...entry.options.inject(),
  }
  return { mounted, props, component: entry.component, draw: () => draw(entry.component, props) }
}

/** Press a rendered button, then settle whatever state it changed. */
async function press(session, node) {
  await node.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return session.draw()
}

test('with no assistant yet, one press creates one and opens it', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push([url, JSON.parse(init.body)])
    if (url === '/side-assistant/list') return json({ ok: true, assistants: [] })
    return json({ ok: true, childId: 'C1', created: true })
  }

  const session = renderAction()
  const tree = await press(session, collect(session.draw(), isTrigger)[0])

  assert.deepEqual(requests, [
    ['/side-assistant/list', { sessionId: 'S1' }],
    ['/side-assistant/ensure', { sessionId: 'S1' }],
  ])
  assert.deepEqual(session.mounted.opened, ['dsh-resource://sideassistant/chat/C1?parent=S1'])
  assert.equal(collect(tree, isMenu).length, 0, 'nothing to choose means no menu')
})

test('one existing assistant makes the press open a menu, not a new chat', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push([url, JSON.parse(init.body)])
    if (url === '/side-assistant/list') {
      return json({ ok: true, assistants: [{ childId: 'C1', label: '侧边助手', createdAt: 1 }] })
    }
    return json({ ok: true, childId: 'C2', created: true })
  }

  const session = renderAction()
  let tree = await press(session, collect(session.draw(), isTrigger)[0])

  assert.deepEqual(menuLabels(tree), ['助手 1', '新建助手'])
  assert.deepEqual(requests, [['/side-assistant/list', { sessionId: 'S1' }]])
  assert.deepEqual(session.mounted.opened, [], 'a press alone must not create anything')

  tree = await press(session, collect(tree, isItem)[1])
  assert.deepEqual(requests[1], ['/side-assistant/ensure', { sessionId: 'S1', create: true }])
  assert.deepEqual(session.mounted.opened, ['dsh-resource://sideassistant/chat/C2?parent=S1'])
  assert.equal(collect(tree, isMenu).length, 0, 'choosing closes the menu')
})

test('choosing an assistant reopens that child instead of creating one', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push([url, JSON.parse(init.body)])
    if (url === '/side-assistant/list') {
      return json({
        ok: true,
        assistants: [
          { childId: 'C1', label: '侧边助手', createdAt: 1 },
          { childId: 'C2', label: '侧边助手', createdAt: 2 },
        ],
      })
    }
    return json({ ok: true, childId: 'C1', created: false })
  }

  const session = renderAction()
  const tree = await press(session, collect(session.draw(), isTrigger)[0])
  assert.deepEqual(menuLabels(tree), ['助手 1', '助手 2', '新建助手'])

  await press(session, collect(tree, isItem)[0])
  assert.deepEqual(requests[1], ['/side-assistant/ensure', { sessionId: 'S1', childId: 'C1' }])
  assert.deepEqual(session.mounted.opened, ['dsh-resource://sideassistant/chat/C1?parent=S1'])
})

test('an outside press or Escape closes the menu, a press inside keeps it', async () => {
  globalThis.fetch = async (url) => (url === '/side-assistant/list'
    ? json({ ok: true, assistants: [{ childId: 'C1', label: '侧边助手', createdAt: 1 }] })
    : json({ ok: true, childId: 'C1', created: false }))

  const session = renderAction()
  let tree = await press(session, collect(session.draw(), isTrigger)[0])
  assert.equal(collect(tree, isMenu).length, 1)

  const onPointerDown = domListeners.get('pointerdown')
  const onKeyDown = domListeners.get('keydown')
  assert.equal(typeof onPointerDown, 'function', 'an open menu listens for outside presses')
  assert.equal(typeof onKeyDown, 'function', 'an open menu listens for Escape')

  onPointerDown({ target: tree })
  session.draw()
  assert.equal(collect(session.draw(), isMenu).length, 1, 'a press inside keeps the menu open')

  onPointerDown({ target: { nodeType: 1 } })
  assert.equal(collect(session.draw(), isMenu).length, 0, 'a press outside closes the menu')

  tree = await press(session, collect(session.draw(), isTrigger)[0])
  onKeyDown({ key: 'Escape' })
  assert.equal(collect(session.draw(), isMenu).length, 0, 'Escape closes the menu')
})

test('a failed list leaves the button in its error state and opens nothing', async () => {
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: false, error: 'internal', message: '侧边助手挂了' }),
  })

  const session = renderAction()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const tree = await press(session, collect(session.draw(), isTrigger)[0])
    assert.equal(collect(tree, isTrigger)[0].props['data-state'], 'error')
  } finally {
    console.warn = originalWarn
  }
  assert.ok(warnings.some((line) => line.includes('list failed')), 'the failure is logged')
  assert.deepEqual(session.mounted.opened, [])
})

/** ------------------------------------------------------- the pane, rendered */

/** A follow stream that yields `frames`, then stays open until aborted. */
function fakeFollow(frames) {
  const calls = []
  const session = {
    follow(request, signal) {
      calls.push({ request, signal })
      return (async function* stream() {
        for (const frame of frames) {
          if (signal.aborted) return
          yield frame
        }
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
      })()
    },
  }
  return { calls, remote: { session } }
}

/**
 * Stand-ins for the two props the pane body renders. `SessionProvider` is
 * never invoked (React calls it, the stub only stores the type), so it is
 * matched by name in the rendered tree below.
 */
function SessionProvider(given) {
  return { type: 'SessionProvider', props: given, children: given.children }
}

/** Render the pane body, then return its progress strip and the strip's tree. */
async function renderPane(follow = fakeFollow([])) {
  const mounted = mount()
  const entry = mounted.getPane()
  const dictionary = mounted.getLocale().dictionaries.zh
  const reference = { kind: 'session-reference' }
  const value = {
    address: { parentSessionId: 'S1', childSessionId: 'C1', mode: 'continuable' },
    reference,
  }
  const props = {
    useTabInfo: () => ({ tab: { id: 'T1', contentId: 'dsh-resource://sideassistant/chat/C1?parent=S1' } }),
    useResource: () => ({ value }),
    SessionProvider,
    renderSlot: (name, args) => ({ type: `slot:${name}`, props: args, children: [] }),
    renderFactorySlot: (key, args, opts) => ({ type: `factory:${key}`, props: args, opts, children: [] }),
    t: (key) => dictionary[key] ?? key,
    ...entry.options.inject(),
    remote: follow.remote,
  }
  hookSlots = []
  const tree = await drawAsync(entry.component, props)
  const panel = collect(tree, isPanelNode)[0]
  return {
    mounted,
    tree,
    follow,
    reference,
    panel: panel ?? null,
    mountPanel: () => {
      if (panel === null) throw new Error('the pane did not render a progress panel')
      hookSlots = []
      return {
        props: panel.props,
        type: panel.type,
        draw: () => draw(panel.type, panel.props),
        drawAsync: () => drawAsync(panel.type, panel.props),
      }
    },
  }
}

/** The progress strip node, recognised by the props the pane passes it. */
const isPanelNode = (node) => typeof node.type === 'function' && node.props.parentSessionId === 'S1'

const isDot = (node) => node.props.className === 'dsh-sa-progress__dot'
const isBody = (node) => node.props.className === 'dsh-sa-progress__body'
const isToggle = (node) => node.props.className === 'dsh-sa-progress__toggle'
const isThinking = (node) => node.props.className === 'dsh-sa-progress__thinking'
const isLabel = (node) => node.props.className === 'dsh-sa-progress__label'
const isRow = (node) => typeof node.props.className === 'string'
  && node.props.className.includes('dsh-sa-progress__row')
const rowLabels = (tree) => collect(tree, isRow).map((node) => node.children.map((child) => (
  typeof child === 'object' && child !== null ? child.children.join('') : String(child)
)).join(''))

/**
 * Draw the strip unfolded, whichever way it mounted.
 *
 * The unfold is remembered for the life of the page, so a later test may find
 * it already unfolded: ask for the body instead of assuming it.
 */
async function unfoldStrip(panel) {
  let tree = await panel.drawAsync()
  if (collect(tree, isBody).length === 0) {
    await collect(tree, isToggle)[0].props.onClick()
    tree = await panel.drawAsync()
  }
  return tree
}

/** Draw the strip folded, whichever way it mounted. */
async function foldStrip(panel) {
  let tree = await panel.drawAsync()
  if (collect(tree, isBody).length > 0) {
    await collect(tree, isToggle)[0].props.onClick()
    tree = await panel.drawAsync()
  }
  return tree
}

test('the pane elects the embedded chat and carries the sidebar anchor', async () => {
  const pane = await renderPane()
  const root = collect(pane.tree, (node) => node.props.className === 'side-assistant-pane')[0]
  assert.ok(root, 'the pane root must exist')
  assert.equal(root.props['data-sidebar-chat'], '', 'the trim CSS selects on this attribute')

  const provider = collect(pane.tree, (node) => node.type.name === 'SessionProvider')[0]
  assert.equal(provider.props.session, pane.reference, 'the chat is bound to the retained Session')

  const chat = collect(pane.tree, (node) => node.type === 'factory:conversation.content')[0]
  assert.ok(chat, 'the embedded conversation must be elected')
  assert.equal(chat.props.variant, 'embedded', 'the sidebar variant is the embedded one')
  assert.equal(chat.props.phase, 'active', 'a detached Session has no metadata to settle on')
  assert.equal(chat.props.hero, false, 'the pane never shows the empty hero')

  const views = chat.opts.slots.views
  const view = views({ renderSlot: (name, args) => ({ type: `slot:${name}`, props: args }) })
  assert.equal(view.type, 'slot:conversation.session', 'the view renders the chat view')
  assert.deepEqual(view.props, { view: 'chat' })

  assert.ok(pane.panel, 'the progress strip must be rendered above it')
})

test('the pane survives a chat that throws while binding', async () => {
  const pane = await renderPane()
  const boundary = collect(pane.tree, (node) => typeof node.type === 'function' && node.type.name === 'ChatBoundary')[0]
  assert.ok(boundary, 'a failure must be caught inside the chat area')
  assert.equal(boundary.props.message, '侧边对话加载失败')
})

test('the follow request names the main Session and opts into the live stream', async () => {
  const follow = fakeFollow([])
  const pane = await renderPane(follow)
  pane.mountPanel().draw()
  assert.equal(follow.calls.length, 1)
  assert.deepEqual(follow.calls[0].request, {
    address: { kind: 'session', sessionId: 'S1' },
    assistantStream: true,
  })
  assert.ok(follow.calls[0].signal instanceof AbortSignal)
})

test('the strip starts folded: one line, and it still follows', async () => {
  const follow = fakeFollow([])
  const pane = await renderPane(follow)
  const tree = pane.mountPanel().draw()
  assert.equal(collect(tree, isBody).length, 0, 'a fresh pane does not spend height on the strip')
  assert.equal(collect(tree, isToggle)[0].props['aria-expanded'], false)
  assert.equal(collect(tree, isLabel)[0].children[0], '主 Agent 进展', 'the folded head still names what it is')
  assert.ok(collect(tree, isDot)[0], 'and still reports the stream')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(follow.calls.length, 1, 'folding is presentation only: the follow is subscribed')
})

test('an empty strip says it is waiting, and closing it aborts the follow', async () => {
  const follow = fakeFollow([])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())
  assert.ok(collect(tree, isBody)[0], 'the strip unfolds on a press')
  assert.equal(collect(tree, (node) => node.props.className === 'dsh-sa-progress__empty')[0].children[0], '等待主 Agent 的下一步…')
  assert.equal(collect(tree, isDot)[0].props['data-state'], 'idle')

  unmount()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(follow.calls[0].signal.aborted, true, 'an unmounted strip stops following')
})

test('unfolding is remembered for the page, folding again is too', async () => {
  const pane = await renderPane()
  const unfolded = await unfoldStrip(pane.mountPanel())
  assert.ok(collect(unfolded, isBody)[0], 'the press unfolds it')

  const remounted = pane.mountPanel()
  assert.ok(collect(remounted.draw(), isBody)[0], 'a remount keeps the user\'s unfold')

  const folded = await foldStrip(pane.mountPanel())
  assert.equal(collect(folded, isBody).length, 0, 'and the next press folds it back')
  assert.equal(collect(pane.mountPanel().draw(), isBody).length, 0, 'a remount keeps that too')
})

test('a snapshot seeds the rows with the tools already run', async () => {
  const follow = fakeFollow([{
    type: 'snapshot',
    records: [
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'read_file' } } },
      { type: 'event', event: { type: 'tool/result', data: { message: { callId: 'c1' } } } },
      { type: 'event', event: { type: 'tool/call', data: { callId: 'c2', name: 'bash' } } },
    ],
  }])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())
  assert.deepEqual(collect(tree, isRow).map((node) => node.props['data-status']), ['done', 'running'])
  assert.deepEqual(rowLabels(tree), ['✓read_file', '·bash'])
})

test('a live turn shows its tools, their outcome and the chain of thought', async () => {
  const follow = fakeFollow([
    { type: 'event', event: { type: 'turn/start', data: { turn: 4 } } },
    { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'bash' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '先看看' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '目录结构' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '（回答正文不进这里）' } } },
  ])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())

  assert.equal(collect(tree, isDot)[0].props['data-state'], 'live', 'a turn in flight pulses')
  assert.deepEqual(collect(tree, isRow).map((node) => node.props['data-status']), ['running'])
  assert.equal(collect(tree, isThinking)[0].children[0], '先看看目录结构', 'reasoning deltas accumulate')
  assert.equal(collect(tree, (node) => node.props.className === 'dsh-sa-progress__empty').length, 0)
})

test('a failed tool and a finished turn settle the strip', async () => {
  const follow = fakeFollow([
    { type: 'event', event: { type: 'turn/start', data: { turn: 1 } } },
    { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'bash' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '试试' } } },
    { type: 'event', event: { type: 'tool/result', data: { message: { callId: 'c1', isError: true } } } },
    { type: 'event', event: { type: 'turn/end', data: { turn: 1 } } },
  ])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())

  assert.deepEqual(collect(tree, isRow).map((node) => node.props['data-status']), ['failed', undefined])
  assert.deepEqual(rowLabels(tree), ['!bash', '—本轮结束'])
  const thoughts = collect(tree, isThinking)
  assert.equal(thoughts.length, 1, 'a finished turn keeps its thought, it does not drop it')
  assert.equal(thoughts[0].props['data-status'], 'done', 'and marks it settled')
  assert.equal(thoughts[0].children[0], '试试')
  assert.equal(collect(tree, isDot)[0].props['data-state'], 'idle')
})

test('opening mid-step backfills the chain of thought already streamed', async () => {
  const follow = fakeFollow([
    {
      type: 'snapshot',
      records: [],
      assistantStream: {
        revision: 3,
        activeAttempt: {
          attemptId: 'S1:1',
          turn: 2,
          step: 1,
          nextIndex: 3,
          stream: [
            {
              type: 'reasoning-chunks',
              time0: 1,
              index: 0,
              dt: [1, 1, 1],
              texts: ['先读', '一下', '目录', '（这一条还没发出去）'],
            },
          ],
        },
      },
    },
    {
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'S1:1', turn: 2, step: 1, chunk: { type: 'reasoning-delta', text: '，再决定' } },
    },
  ])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())

  const thoughts = collect(tree, isThinking)
  assert.equal(thoughts.length, 1, 'the attempt that was already running gets its own block')
  assert.equal(thoughts[0].children[0], '先读一下目录，再决定', 'the published prefix is backfilled, then the live delta appends')
  assert.equal(thoughts[0].props['data-status'], 'live')
})

test('a step that settled before the pane opened still shows its thought', async () => {
  const follow = fakeFollow([{
    type: 'snapshot',
    records: [{
      type: 'event',
      event: {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          stream: [
            { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1], texts: ['先看测试', '再改代码'] },
            { type: 'text-chunks', time0: 9, index: 0, dt: [], texts: ['正文不进这里'] },
          ],
        },
      },
    }],
  }])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())

  const thoughts = collect(tree, isThinking)
  assert.equal(thoughts.length, 1, 'a settled step is recovered from its durable record')
  assert.equal(thoughts[0].children[0], '先看测试再改代码', 'only the reasoning is kept, not the answer text')
  assert.equal(thoughts[0].props['data-status'], 'done')
})

test('a second step keeps the first step\'s thought', async () => {
  const follow = fakeFollow([
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '第一步的想法' } } },
    { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a1', turn: 1, step: 1 } },
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a2', turn: 1, step: 2 } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a2', turn: 1, step: 2, chunk: { type: 'reasoning-delta', text: '第二步的想法' } } },
  ])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())

  const thoughts = collect(tree, isThinking)
  assert.deepEqual(thoughts.map((node) => node.children[0]), ['第一步的想法', '第二步的想法'])
  assert.deepEqual(thoughts.map((node) => node.props['data-status']), ['done', 'live'])
})

test('thought blocks are bounded, and the newest is kept', async () => {
  const frames = []
  for (let step = 1; step <= 10; step += 1) {
    frames.push({ type: 'assistant-stream', frame: { type: 'start', attemptId: `a${step}`, turn: 1, step } })
    frames.push({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: `a${step}`, turn: 1, step, chunk: { type: 'reasoning-delta', text: `想${step}` } } })
    frames.push({ type: 'assistant-stream', frame: { type: 'end', attemptId: `a${step}`, turn: 1, step } })
  }
  const pane = await renderPane(fakeFollow(frames))
  const tree = await unfoldStrip(pane.mountPanel())

  const thoughts = collect(tree, isThinking)
  assert.equal(thoughts.length, 6, 'the strip keeps the recent past, not the whole run')
  assert.equal(thoughts[thoughts.length - 1].children[0], '想10', 'the newest block survives')
})

test('the folded head previews the newest thought', async () => {
  const follow = fakeFollow([
    {
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'a1', turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '先确认依赖版本，\n再决定要不要升级' } },
    },
  ])
  const pane = await renderPane(follow)
  const tree = await foldStrip(pane.mountPanel())

  assert.equal(collect(tree, isBody).length, 0, 'the strip stays folded')
  const preview = collect(tree, (node) => node.props.className === 'dsh-sa-progress__preview')[0]
  assert.ok(preview, 'the folded head still shows what the main Agent is thinking')
  assert.equal(preview.children[0], '先确认依赖版本， 再决定要不要升级')
})

test('a result for an unknown call settles nothing', async () => {
  const follow = fakeFollow([
    { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'bash' } } },
    { type: 'event', event: { type: 'tool/result', data: { message: { callId: 'nope' } } } },
    { type: 'event', event: { type: 'tool/result', data: {} } },
  ])
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())
  assert.deepEqual(collect(tree, isRow).map((node) => node.props['data-status']), ['running'])
})

test('the rows are bounded', async () => {
  const frames = [{ type: 'event', event: { type: 'turn/start', data: { turn: 1 } } }]
  for (let index = 0; index < 60; index += 1) {
    frames.push({ type: 'event', event: { type: 'tool/call', data: { callId: `c${index}`, name: `tool${index}` } } })
  }
  const follow = fakeFollow(frames)
  const pane = await renderPane(follow)
  const tree = await unfoldStrip(pane.mountPanel())
  const labels = rowLabels(tree)
  assert.equal(labels.length, 30)
  assert.equal(labels[labels.length - 1], '·tool59', 'the newest row is kept')
})

test('a broken stream marks the strip and never throws', async () => {
  const remote = {
    session: {
      follow() {
        return (async function* stream() {
          throw new Error('carrier down')
        })()
      },
    },
  }
  const mounted = mount()
  const entry = mounted.getPane()
  const dictionary = mounted.getLocale().dictionaries.zh
  const props = {
    useTabInfo: () => ({ tab: { contentId: 'a' } }),
    useResource: () => ({ value: { address: { parentSessionId: 'S1', childSessionId: 'C1' }, reference: {} } }),
    SessionProvider,
    renderSlot: () => null,
    t: (key) => dictionary[key] ?? key,
    ...entry.options.inject(),
    remote,
  }
  const originalWarn = console.warn
  console.warn = () => {}
  let tree = null
  try {
    hookSlots = []
    tree = await drawAsync(entry.component, props)
    const panel = collect(tree, isPanelNode)[0]
    hookSlots = []
    tree = await drawAsync(panel.type, panel.props)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(collect(tree, isDot)[0].props['data-state'], 'error')
  assert.equal(collect(tree, isLabel)[0].children[0], '进展读不到，看看控制台')
})

test('a pane without the remote still renders the chat', async () => {
  const mounted = mount()
  const entry = mounted.getPane()
  const dictionary = mounted.getLocale().dictionaries.zh
  const props = {
    useTabInfo: () => ({ tab: { contentId: 'a' } }),
    useResource: () => ({ value: { address: { parentSessionId: 'S1', childSessionId: 'C1' }, reference: { tag: 1 } } }),
    SessionProvider,
    renderSlot: () => null,
    renderFactorySlot: (key, args, opts) => ({ type: `factory:${key}`, props: args, opts, children: [] }),
    t: (key) => dictionary[key] ?? key,
    ...entry.options.inject(),
    remote: undefined,
  }
  hookSlots = []
  const tree = await drawAsync(entry.component, props)
  assert.ok(collect(tree, (node) => node.type.name === 'SessionProvider')[0], 'the chat must survive a missing remote')
})

/** The delete controls the menu carries: one two-character word per row. */
const isMenuDelete = (node) => node.props.className === 'side-assistant__menu-delete'
const menuDeletes = (tree) => collect(tree, isMenuDelete)
const deleteLabels = (tree) => menuDeletes(tree).map((node) => node.children.join(''))

const assistant = (childId, createdAt) => ({ childId, label: '侧边助手', createdAt })

test('every assistant row in the menu carries a two-character delete control', async () => {
  globalThis.fetch = async (url) => (url === '/side-assistant/list'
    ? json({ ok: true, assistants: [assistant('C1', 1), assistant('C2', 2)] })
    : json({ ok: true, childId: 'C3', created: true }))

  const session = renderAction()
  const tree = await press(session, collect(session.draw(), isTrigger)[0])

  assert.deepEqual(menuLabels(tree), ['助手 1', '助手 2', '新建助手'])
  assert.deepEqual(deleteLabels(tree), ['删除', '删除'], 'one per assistant, none on the new-chat row')
  assert.equal(session.mounted.archived.length, 0, 'showing the menu deletes nothing')
})

test('deleting from the menu asks once, then archives the child and drops the row', async () => {
  const requests = []
  let listCalls = 0
  globalThis.fetch = async (url, init) => {
    requests.push([url, JSON.parse(init.body)])
    if (url !== '/side-assistant/list') return json({ ok: true, childId: 'C1', created: false })
    listCalls += 1
    return json({ ok: true, assistants: listCalls === 1 ? [assistant('C1', 1), assistant('C2', 2)] : [assistant('C2', 2)] })
  }

  const session = renderAction()
  let tree = await press(session, collect(session.draw(), isTrigger)[0])

  tree = await press(session, menuDeletes(tree)[0])
  assert.deepEqual(deleteLabels(tree), ['确认', '删除'], 'only the pressed row asks')
  assert.equal(session.mounted.archived.length, 0, 'the first press only asks')

  tree = await press(session, menuDeletes(tree)[0])
  assert.deepEqual(session.mounted.archived, [{ sessionId: 'C1', options: { stopActivity: true } }])
  assert.deepEqual(requests, [
    ['/side-assistant/list', { sessionId: 'S1' }],
    ['/side-assistant/list', { sessionId: 'S1' }],
  ])
  assert.deepEqual(menuLabels(tree), ['助手 1', '新建助手'], 'the surviving assistant shifts up a number')
  assert.deepEqual(deleteLabels(tree), ['删除'])
  assert.equal(collect(tree, isMenu).length, 1, 'the menu stays open for the next one')
})

test('deleting the only assistant closes the menu', async () => {
  let listCalls = 0
  globalThis.fetch = async (url) => {
    if (url !== '/side-assistant/list') return json({ ok: true, childId: 'C2', created: true })
    listCalls += 1
    return json({ ok: true, assistants: listCalls === 1 ? [assistant('C1', 1)] : [] })
  }

  const session = renderAction()
  let tree = await press(session, collect(session.draw(), isTrigger)[0])
  tree = await press(session, menuDeletes(tree)[0])
  assert.deepEqual(deleteLabels(tree), ['确认'])
  tree = await press(session, menuDeletes(tree)[0])

  assert.deepEqual(session.mounted.archived, [{ sessionId: 'C1', options: { stopActivity: true } }])
  assert.equal(collect(tree, isMenu).length, 0, 'an emptied menu has nothing to show')
})

test('a failed delete stays on screen and says so', async () => {
  globalThis.fetch = async (url) => (url === '/side-assistant/list'
    ? json({ ok: true, assistants: [assistant('C1', 1)] })
    : json({ ok: true, childId: 'C2', created: true }))

  const session = renderAction()
  session.mounted.ctx.workspaces.archiveSession = () => Promise.reject(new Error('workspace offline'))
  const originalWarn = console.warn
  console.warn = () => {}
  let tree = null
  try {
    tree = await press(session, collect(session.draw(), isTrigger)[0])
    tree = await press(session, menuDeletes(tree)[0])
    tree = await press(session, menuDeletes(tree)[0])
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(deleteLabels(tree), ['删除失败'])
  assert.equal(menuDeletes(tree)[0].props['data-failed'], 'true')
  assert.deepEqual(menuLabels(tree), ['助手 1', '新建助手'], 'the row is still there to retry')
})

test('deleting an assistant that is on screen closes its tab', async () => {
  // The pane is the only place that knows a child id and its tab id together,
  // so it records the pair while mounted; deleting then closes that tab.
  await renderPane()
  const mounted = mount()
  const actions = mounted.getHeaderAction().options.inject()

  await actions.deleteSideAssistant('C1')

  assert.deepEqual(mounted.archived, [{ sessionId: 'C1', options: { stopActivity: true } }])
  assert.deepEqual(mounted.closed, ['T1'], 'the pane for the deleted assistant goes with it')
  unmount()
})

test('deleting an assistant that is not on screen touches no tab', async () => {
  const mounted = mount()
  const actions = mounted.getHeaderAction().options.inject()

  await actions.deleteSideAssistant('CX')

  assert.deepEqual(mounted.archived, [{ sessionId: 'CX', options: { stopActivity: true } }])
  assert.deepEqual(mounted.closed, [], 'nothing was open for it')
  unmount()
})

/** ------------------------------------------ the settings page, rendered */

/** The settings document the fake Host answers with. */
function settingsPayload(overrides = {}) {
  return {
    ok: true,
    settings: {
      label: '我的助手',
      opener: '你好',
      modelMode: 'host',
      provider: 'deepseek',
      model: 'deepseek-chat',
      custom: { baseURL: '', model: '', apiKeyEnv: 'SIDE_ASSISTANT_API_KEY' },
      steps: 9,
      tokens: 12345,
      style: 'detailed',
      ...overrides,
    },
    limits: { steps: [1, 50], tokens: [500, 200000] },
    keyConfigured: true,
  }
}

/** Mount the settings page with its own hook slots. */
function renderSettings(extra = {}) {
  const mounted = mount()
  const entry = mounted.registered.find((row) => row.options.name === 'settings.section')
  assert.ok(entry, 'the settings page must be registered into settings.section')
  unmount()
  hookSlots = []
  const dictionary = mounted.getLocale().dictionaries.zh
  const props = { t: (key) => dictionary[key] ?? key, ...entry.options.inject(), ...extra }
  return {
    mounted,
    entry,
    props,
    draw: () => draw(entry.component, props),
    drawAsync: () => drawAsync(entry.component, props),
  }
}

const inputNamed = (tree, name) => collect(tree, (node) => node.type === 'input' && node.props.name === name)[0]

const buttonWithClass = (tree, className) => collect(tree, (node) => typeof node.props.className === 'string'
  && node.props.className.split(' ').includes(className))[0]

/** Every piece of copy under a tree, for reading what a status line says. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

test('the settings page registers as a settings section with its dictionary title', () => {
  const mounted = mount()
  const entry = mounted.registered.find((row) => row.options.name === 'settings.section')
  assert.ok(entry, 'settings.section must carry the settings page')
  assert.equal(entry.options.id, 'side-assistant')
  assert.equal(entry.options.order, 12)
  assert.equal(entry.options.locale, 'sideAssistant')
  assert.deepEqual(entry.options.inject(), {})
  assert.equal(entry.options.label(), mounted.getLocale().dictionaries.zh.title)
  assert.equal(entry.options.label(), '侧边助手')
  assert.equal(typeof entry.component, 'function')
})

test('a summary-only mount stays silent and sends no request', async () => {
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    return json(settingsPayload())
  }

  const session = renderSettings({ view: 'summary' })
  const tree = await session.drawAsync()

  assert.equal(Array.isArray(tree), false)
  assert.ok(textOf(tree).includes('右侧栏'))
  assert.deepEqual(collect(tree, (node) => node.type === 'input'), [])
  assert.deepEqual(requests, [], 'the unopened row must not read settings')
  unmount()
})

test('the settings page loads the stored settings on mount', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push([url, init.method])
    return json(settingsPayload())
  }

  const session = renderSettings()
  const tree = await session.drawAsync()

  assert.deepEqual(requests, [['/side-assistant/settings', 'GET']])
  assert.equal(inputNamed(tree, 'steps').props.value, 9)
  assert.equal(inputNamed(tree, 'tokens').props.value, 12345)
  assert.equal(inputNamed(tree, 'label').props.value, '我的助手')
  assert.equal(inputNamed(tree, 'opener').props.value, '你好')
  // The host mode's fields carry what the document selected.
  assert.equal(inputNamed(tree, 'provider').props.value, 'deepseek')
  assert.equal(inputNamed(tree, 'model').props.value, 'deepseek-chat')
  const selected = collect(tree, (node) => node.type === 'input'
    && node.props.name === 'style'
    && node.props.checked === true)
  assert.equal(selected.length, 1, 'exactly one style is checked')
  assert.equal(selected[0].props.value, 'detailed')
  unmount()
})

test('pressing save posts the edited numbers as part of the settings', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    const body = init.method === 'POST' ? JSON.parse(init.body) : undefined
    requests.push([url, init.method, body])
    if (init.method === 'POST') return json({ ok: true, settings: settingsPayload().settings, keyConfigured: true })
    return json(settingsPayload())
  }

  const session = renderSettings()
  let tree = await session.drawAsync()

  inputNamed(tree, 'steps').props.onChange({ target: { value: '7' } })
  tree = session.draw()
  assert.equal(inputNamed(tree, 'steps').props.value, 7, 'the edit shows before the save')

  tree = await press(session, buttonWithClass(tree, 'dsh-sa-settings-save'))

  assert.deepEqual(requests[0], ['/side-assistant/settings', 'GET', undefined])
  const posted = requests[1]
  assert.equal(posted[0], '/side-assistant/settings')
  assert.equal(posted[1], 'POST')
  assert.equal(posted[2].settings.steps, 7)
  assert.equal('apiKey' in posted[2], false, 'a blank key field must not overwrite the stored one')
  assert.ok(textOf(tree).includes('已保存'))
  unmount()
})

test('testing the connection reports the round trip and the model', async () => {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push([url, init.method, init.method === 'POST' ? JSON.parse(init.body) : undefined])
    if (url === '/side-assistant/ping') {
      return json({ ok: true, ms: 320, provider: 'deepseek', model: 'deepseek-chat', text: 'pong' })
    }
    return json(settingsPayload())
  }

  const session = renderSettings()
  let tree = await session.drawAsync()
  tree = await press(session, buttonWithClass(tree, 'dsh-sa-settings-test'))

  assert.deepEqual(requests[1], ['/side-assistant/ping', 'POST', {}])
  assert.ok(textOf(tree).includes('连接正常 · 320ms · deepseek/deepseek-chat'))
  unmount()
})

test('a failed connection test shows the host message', async () => {
  globalThis.fetch = async (url) => (url === '/side-assistant/ping'
    ? json({ ok: false, error: 'provider/unavailable', message: '模型 deepseek-chat 不可用' })
    : json(settingsPayload()))

  const session = renderSettings()
  let tree = await session.drawAsync()
  tree = await press(session, buttonWithClass(tree, 'dsh-sa-settings-test'))

  const errors = collect(tree, (node) => node.props.className === 'dsh-sa-settings-error')
  assert.ok(errors.length >= 1, 'a failed probe must be on screen')
  assert.ok(textOf(errors[0]).includes('模型 deepseek-chat 不可用'))
  assert.equal(textOf(tree).includes('连接正常'), false)
  unmount()
})

test('a failed load shows the error and leaves the defaults usable', async () => {
  globalThis.fetch = async () => json({ ok: false, error: 'storage/read-failed', message: '设置文件读不出来' })

  const session = renderSettings()
  const tree = await session.drawAsync()

  const errors = collect(tree, (node) => node.props.className === 'dsh-sa-settings-error')
  assert.ok(errors.length >= 1)
  assert.ok(textOf(errors[0]).includes('设置文件读不出来'))
  assert.equal(inputNamed(tree, 'steps').props.value, 5, 'the shipped defaults fill the form')
  assert.equal(buttonWithClass(tree, 'dsh-sa-settings-save').props.disabled, false)
  unmount()
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
