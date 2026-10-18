/**
 * Address contract test for `side-assistant`.
 *
 * The browser half opens the side panel by handing a resource address to
 * `sidebarRight.openResource()`. That call has no fallback: an address no tab
 * type claims throws (`sidebarRight: no registered tab type claims "…"`). Since
 * 0.7.0 the plugin owns that tab type (`kind: "sideassistant"`, protocol
 * `sideassistant`) instead of borrowing `subagentchat`, so this test pins the
 * legs of the contract that are still ours to keep:
 *
 *   1. the builder in `client.js` produces the address the registered glob
 *      (`dsh-resource://sideassistant/chat/**`, matched whole-string, nocase,
 *      dot:true) claims;
 *   2. the parser in `client.js` reads back exactly what the builder wrote,
 *      cross-checked against an independent URL-based reading of the same
 *      grammar;
 *   3. the two grammars stay DISJOINT from the shipped `subagentchat` one, so
 *      the shipped chat tab keeps its addresses and neither plugin can steal
 *      the other's panels. This leg needs the DSH checkout; when it is
 *      locatable it runs against the real bundle. Point
 *      `DSH_SUBAGENT_CLIENT` at `…/dsh-client-ui-subagent/lib/client.js` to
 *      force a target.
 *
 * Run: node test/address.contract.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(here, '..')

/** Our own grammar: protocol, path segment, mode. */
const PROTOCOL = 'sideassistant'
const KIND_PATH = 'chat'
const MODE = 'continuable'

/**
 * Dsh's chat parser lives in this bundle. Both the sibling layout (a profile's
 * `node_modules`) and the nested layout of a global install
 * (`@deepseek-ai/dsh/node_modules/…`) are probed.
 */
const BUNDLE_TAILS = [
  join('node_modules', '@deepseek-ai', 'dsh-client-ui-subagent', 'lib', 'client.js'),
  join('node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-subagent', 'lib', 'client.js'),
]

/** Every directory from `from` up to the filesystem root. */
function ancestors(from) {
  const out = []
  let current = resolve(from)
  for (;;) {
    out.push(current)
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

/** Candidate locations of the shipped bundle, best first. */
function candidates() {
  const out = []
  if (process.env.DSH_SUBAGENT_CLIENT) out.push(process.env.DSH_SUBAGENT_CLIENT)
  // A global npm install keeps the Harness under `<node>/lib/node_modules`.
  const nodePrefix = dirname(dirname(process.execPath))
  const roots = [
    ...ancestors(PLUGIN_ROOT),
    ...ancestors(process.cwd()),
    join(nodePrefix, 'lib'),
  ]
  for (const root of roots) {
    for (const tail of BUNDLE_TAILS) out.push(join(root, tail))
  }
  return out
}

/** The first candidate that exists, or undefined. */
function locateBundle() {
  return candidates().find((path) => existsSync(path))
}

/**
 * Slice a top-level `function NAME(...) { … }` out of a bundle by brace
 * matching, so the test runs the shipped source rather than a paraphrase.
 * @param text - bundle source.
 * @param name - function name.
 * @returns the function's source text.
 */
function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `bundle does not define ${name}()`)
  let depth = 0
  let index = text.indexOf('{', start)
  for (; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return text.slice(start, index + 1)
}

/** The plugin's own address builder and parser, taken from the shipping file. */
function ourGrammar() {
  const source = readFileSync(join(PLUGIN_ROOT, 'client.js'), 'utf8')
  // The pattern and the address root are module constants the two functions
  // close over, so they have to come along.
  const constants = ['CHAT_PROTOCOL', 'CHAT_ADDRESS', 'CHAT_PATTERN'].map((name) => {
    const line = source.match(new RegExp(`const ${name} = .*`))
    assert.ok(line, `client.js must declare ${name}`)
    return line[0]
  })
  return new Function(
    `${constants.join('\n')}\n`
    + `${extractFunction(source, 'chatAddress')}\n`
    + `${extractFunction(source, 'parseChatAddress')}\n`
    + 'return { chatAddress, parseChatAddress };',
  )()
}

/**
 * The grammar read independently, through the URL parser instead of the regex
 * the shipping file uses. Two readers disagreeing is what this leg catches.
 * @param value - candidate address.
 * @returns `{ parentSessionId, childSessionId, mode }`, or undefined.
 */
function parseViaUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== PROTOCOL) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== KIND_PATH) return undefined
  const parentSessionId = url.searchParams.get('parent')
  if (parentSessionId === null || parentSessionId === '') return undefined
  try {
    return { parentSessionId, childSessionId: decodeURIComponent(parts[1]), mode: MODE }
  } catch {
    return undefined
  }
}

/**
 * picomatch, exactly as the sidebar tab registry uses it for a whole-address
 * pattern (`nocase: true, dot: true`). Probes each ancestor of `from`, since the
 * package lives somewhere above the bundle inside the Harness's own tree.
 * @param from - a directory inside the Harness install.
 * @returns a compiled matcher, or undefined when picomatch is unavailable.
 */
function globMatcher(from) {
  const pattern = `dsh-resource://${PROTOCOL}/${KIND_PATH}/**`
  for (const dir of ancestors(from)) {
    try {
      const require = createRequire(join(dir, 'noop.js'))
      return require('picomatch')(pattern, { nocase: true, dot: true })
    } catch {
      // Not resolvable from here; try the next ancestor.
    }
  }
  return undefined
}

/** Awkward ids: the address is a URI, so everything must survive encoding. */
const CASES = [
  ['session-1', 'child-1'],
  ['session with spaces', 'child with spaces'],
  ['中文会话', '中文子会话'],
  ['a&b=c?d', 'weird#id/slash'],
  ['emoji-🎯', 'child-✅'],
]

const { chatAddress, parseChatAddress } = ourGrammar()
const bundle = locateBundle()
const matchesGlob = bundle === undefined ? undefined : globMatcher(dirname(bundle))

/**
 * Where we can read the shipped grammar, cross-check that the two address
 * spaces do not overlap: our parser must reject the shipped builder's output,
 * and the shipped parser must reject ours.
 */
let shipped = null
if (bundle !== undefined) {
  const source = readFileSync(bundle, 'utf8')
  const constant = source.match(/const SUBAGENT_CHAT_ADDRESS = .*/)
  assert.ok(constant, 'the shipped bundle must define SUBAGENT_CHAT_ADDRESS')
  shipped = new Function(
    `${constant[0]}\n`
    + `${extractFunction(source, 'subagentChatAddress')}\n`
    + `${extractFunction(source, 'parseSubagentChatAddress')}\n`
    + 'return { subagentChatAddress, parseSubagentChatAddress };',
  )()
}

let failed = 0
for (const [parent, child] of CASES) {
  const ours = chatAddress(child, parent)
  try {
    // 1. the address is the URI our own protocol implies, and it round-trips
    assert.deepEqual(parseChatAddress(ours), { parentSessionId: parent, childSessionId: child, mode: MODE })
    // 2. an independent reader agrees. `mode` is deliberately NOT in our
    // address: a side assistant is always continuable, so spelling it out
    // would only add a way to write an invalid one.
    assert.deepEqual(parseViaUrl(ours), { parentSessionId: parent, childSessionId: child, mode: MODE })
    assert.equal(new URL(ours).protocol, 'dsh-resource:')
    assert.equal(new URL(ours).hostname, PROTOCOL)
    assert.equal(new URL(ours).searchParams.get('mode'), null)
    // 3. the glob registered for this kind claims it
    if (matchesGlob) assert.ok(matchesGlob(ours), 'the registered glob must claim our own address')
    // 4. and it is NOT the shipped chat's address
    if (shipped) {
      const theirs = shipped.subagentChatAddress({ parentSessionId: parent, childSessionId: child, mode: MODE })
      assert.notEqual(ours, theirs, 'the two grammars must not collide')
      assert.equal(shipped.parseSubagentChatAddress(ours), undefined, 'the shipped parser must reject our address')
      assert.equal(parseChatAddress(theirs), undefined, 'our parser must reject the shipped address')
    }
    console.log(`  ok  ${JSON.stringify(parent)} → ${child}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${JSON.stringify(parent)} → ${child}: ${error.message}`)
  }
}

/** Addresses neither reader may accept. */
const REJECTED = [
  '',
  'dsh-resource://sideassistant/chat/child-1',
  'dsh-resource://sideassistant/chat/?parent=session-1',
  'dsh-resource://sideassistant/chat/a/b?parent=session-1',
  'dsh-resource://sideassistant/session/child-1?parent=session-1',
  'dsh-resource://subagentchat/session/child-1?parent=session-1&mode=continuable',
  'https://sideassistant/chat/child-1?parent=session-1',
  'not an address',
]

/** Our glob is `${root}**`, so it is a coarse prefix filter, not the gate: the
 * registry calls `canOpen` (our parser) on every address it claims. Only
 * addresses outside our prefix may be claimed by nobody. */
const OUTSIDE_PREFIX = (value) => !value.startsWith(`dsh-resource://${PROTOCOL}/${KIND_PATH}/`)

for (const value of REJECTED) {
  try {
    assert.equal(parseChatAddress(value), undefined, 'our parser must reject this')
    assert.equal(parseViaUrl(value), undefined, 'the URL reader must reject this')
    if (matchesGlob && OUTSIDE_PREFIX(value)) {
      assert.equal(matchesGlob(value), false, 'the registered glob must not claim a foreign address')
    }
    console.log(`  ok  rejects ${JSON.stringify(value)}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  should reject ${JSON.stringify(value)}: ${error.message}`)
  }
}

const total = CASES.length + REJECTED.length
console.log('')
console.log(bundle === undefined
  ? 'NOTE  DSH checkout not found — the disjointness leg ran without the shipped grammar. Set DSH_SUBAGENT_CLIENT to cross-check.'
  : `NOTE  cross-checked against ${bundle}`)
console.log(matchesGlob === undefined
  ? 'NOTE  picomatch not resolvable — glob leg skipped.'
  : 'NOTE  glob leg covered with the registry\'s own matcher options.')
console.log(`\n${total - failed}/${total} passed`)
process.exitCode = failed === 0 ? 0 : 1
