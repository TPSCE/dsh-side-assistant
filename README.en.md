# dsh-side-assistant

English · [中文](README.md)

One press opens a **resident side assistant** for the current Session: it knows what this conversation has covered so far (as a compressed summary handed to it as prompt text — nothing of it shows up in its own chat log), you can keep asking it questions without interrupting the main task, and the top of the pane carries a **live progress strip** that folds into a single line — you see what the main Agent is doing and the newest thought at a glance, and unfolding it replays the last few steps of its chain of thought.

Every step the main Agent finishes after that reaches the side assistant as a **progress block** (what it thought, which tools it called, what it concluded), so the side assistant is no longer limited to the moment it was created: ask "what is it doing now" and the answer comes from the newest block. Blocks travel through the system prompt, not the chat log (see [The progress strip](#the-progress-strip-what-the-main-agent-is-thinking)).

The button sits at the right end of the conversation header. Press it and an independent conversation panel appears in the right sidebar: it knows what this Session talked about and did, and from then on you can ask it anything while the main Agent keeps running. When an assistant already exists, the press opens a menu first — **Assistant 1 / Assistant 2 / … / New assistant** — so you can reopen an older one or start another (each independent, each given the same summary of the history).

A side assistant **is not a subagent**: it never appears in the subagent catalog, never counts towards subagent limits, never takes a continuable slot, and is absent from the Session list. The only trace it leaves in the subagent system is one line of lineage on the Session header (see [How it works](#how-it-works)).

---

## What it does

| Need | Where it lives |
| --- | --- |
| A side conversation pane with an input and a message stream | Carried by this plugin's own tab type; the chat itself is DSH's `conversation.content` factory (`embedded` variant) |
| **Seeing the main Agent's live progress (tool calls + chain of thought)** | A progress strip drawn at the top of the pane; `session.follow` reads the main Session's event stream and assistant stream directly |
| **The side assistant also learns what happened afterwards** | When the main Agent finishes a step, the Host folds that step into a block and writes it into the side assistant's system-prompt fragment (`side-assistant:progress`) — never into the chat log |
| **Knowing the history the main Session already finished** | At creation the main Session's completed turns are folded into a summary and mounted as the prompt context `side-assistant:history` (order 120) — the assistant's own log starts at the greeting, so the pane shows no copy of the main conversation |
| Asking again and again (a persistent assistant) | The Session carries its own `subagent/descriptor`; every question cold-resumes it, and the record stays |
| **Taking no subagent slot at all** | Created with `ctx.agents.create()` as a detached Session — **no** `subagent/catalog` fact is appended |
| Surviving a close and reopen | The sidebar keeps open tabs per Session in localStorage |
| Several assistants per Session, reopening any of them | A press opens the menu: existing ones numbered in creation order, plus "New assistant" at the end |
| **Two shortcut cards under the answer** | Two rounded rectangles mounted into `conversation.input.dock`: `What is this project about?` / `What is the agent working on?`. A click sends it as if typed (`conversation.send`, the composer's own path) |

## What it deliberately does **not** do

- **It does not reimplement a chat UI.** The message stream, Markdown, tool calls, streaming, Stop and paging back all come from `@deepseek-ai/dsh-client-ui-conversation`'s `conversation.content` factory (`embedded` variant); this plugin only adds its own tab type, its resource provider and that progress strip. Hand-rolling one would only be worse. The phase is always passed as `active`: a detached Session has no metadata the client can judge, and letting the factory judge would leave an empty shell.
- **It does not register itself as a subagent.** It never calls `ctx.subagents.startContinuable()` and never appends `subagent/catalog` to the parent. `parentSession` is a lineage field (workspace grouping + sidebar addressing), not a runtime parent relationship (no `parentAgent` at creation). The subagent catalog, counts, Session tree and `list_agents` all read that catalog fact and only that fact.
- **It does not poll the main Session.** The strip uses the framework's own push: `session.follow` (durable events + `assistantStream` deltas). No private `/status`, no timers.
- **It does not stuff "progress" into the assistant's chat log.** Blocks go through a system-prompt fragment, not through `user` / `assistant` messages: the log holds only your conversation with it, so scrolling back is not drowned in system broadcasts.
- **It does not write plugin-private events into the Session stream.** The only two log writes are the framework's own protocol events: `subagent/descriptor` (what this Session is) and the sandbox/approval policy overrides inside the creation window (the same as the old delegation path).

## Install

For a `web` profile:

```sh
dsh plugin --profile web add "/Users/a123/Desktop/small talk/dsh-side-assistant"
```

The path contains a space — **quote it**. Refresh the page afterwards; if the button does not appear, restart `dsh web` (the Host half's new routes need a fresh process).

You can also install this local directory from the plugin page of the Web UI.

Uninstall:

```sh
dsh plugin --profile web remove dsh-side-assistant
```

## Usage

1. Open any Session.
2. Press **Side assistant** at the right of the header.
   - No assistant yet: one is created straight away (reads the history summary, sends an opener) and opens in the right sidebar.
   - Assistants already exist: a menu lists **Assistant 1 / Assistant 2 / …** (in creation order) and **New assistant**. Picking one reopens it in the right sidebar (each keeps its own record); picking "New assistant" starts another.
   - To dismiss the menu: click outside it, press `Esc`, or press the button again. Dismissing creates nothing.
3. The top of the pane is a **progress strip**, folded into one line by default (a dot + "主 Agent 进展" + the newest thought):
   unfolded, it shows the main Agent's tool calls, tool results and **the chain of thought of each step** — the block being written is highlighted, finished blocks stay greyed out, so after a turn ends you can still read what it thought. Opening the pane mid-step backfills from the beginning of that step.
   Folding only changes the display — the subscription stays live and the dot keeps blinking; the fold/unfold choice is remembered for the page.
4. Ask away in the input below: it starts one line tall and grows line by line like the main composer. You can keep asking, and Stop interrupts an answer that is being generated.
5. Done with it: press the button again and click **Delete** on the right of that assistant in the menu, then **Confirm**. It disappears from the menu and the tab closes (what is deleted is the *visibility* — the Session log stays on disk and can be restored from the archived list; see [Known boundaries](#known-boundaries) item 6).
6. Closing the pane does not destroy the Session; press the button again and it is back.

## The pane is a single input box

Reusing the shipped conversation view means **inheriting the main conversation's input area as well** — everything any plugin adds to the composer shows up in the side pane too. `SIDEBAR_CSS` in `client.js` trims the pane back to a plain input box, scoped to this pane only:

| Trimmed | Who brings it |
| --- | --- |
| `conversation.composer.dock` (`N turns · M steps · tok/s · cache hit`) | `dsh-client-ui-chat`'s `stats` strip, `dsh-cost-meter` |
| `conversation.input.dock` (`uncommitted changes: N files`, quota bar) | `dsh-client-ui-git-graph`, `dsh-cost-meter`, `@openmaic/dsh-openmaic` |
| `conversation.input.attachments` (attachment bar / drop zone) | `dsh-client-ui-attachment` |
| `conversation.input.left` / `.right` (balance, plugin odds and ends) | `deepseek-harness-wallet`, `@linxin666/dsh-web-all`, etc. |
| `conversation.input.activity` (activity indicator across the tool row) | the conversation shell |
| The whole left row of the input area (`+` upload/command menu + plan + permission pickers) | the conversation shell |

What remains: the message stream, the input, the model picker, Send/Stop, and copy / usage / time under each reply.

To adjust, edit the `TRIMMED_SLOTS` array at the top of `client.js` (one slot per line; delete a line and that thing comes back). If you only want to hide the `+` but keep the "plan / permission" seats, delete the last `div:has(> input[type="file"])` rule in `SIDEBAR_CSS`.

> The trim rules are anchored on `[data-sidebar-chat]`. That attribute used to be set by the shipped subagent tab; now **the plugin's own pane root sets it** (the root `div` of `chatTab`), so the rules still apply only inside the side pane.

### The message action row

The row of buttons under an assistant reply is not in a slot — the chat view draws it itself: copy → the `conversation.chat.assistant-actions` seat → branch → usage + time. Only copy, usage and time are kept:

| Trimmed | How it is recognised |
| --- | --- |
| Thumbs up / down (`dsh-client-ui-message-feedback`), view in the context browser (`dsh-context`) | Both register into the `conversation.chat.assistant-actions` seat; hiding the seat removes them all at once |
| The branch button | The last direct child button of the assistant's footer row |

The branch rule is gated on `[data-actions-reveal]`: only assistant turn footers set that attribute, and the last button in a user bubble's row **is the copy button** — without the gate it would hide the user's copy too. The usage button sits in `span.endInfo`, not as a direct child of that row, so `> button:last-of-type` never reaches it.

### The input starts one line tall, then copies the main composer

The side input **starts one line tall** (24px, exactly the shipped line height); the main conversation's is 36px, so before you fill the first line they are visibly different. Once full it behaves **exactly like the main composer**: each new line adds 24px, and past the shipped ceiling (336px, about 14 lines) it scrolls inside the box.

Only two things move, and both are floors rather than ceilings:

| Rule | Effect |
| --- | --- |
| `[data-composer-input]` gets `min-height: 24px` + `padding-top: 0` | One line is 24px, so that is the starting height; each following line adds 24 |
| `[data-composer-placeholder]`'s `inset` top is zeroed | The placeholder is absolutely positioned and follows the editor's new padding, otherwise it floats below the text |

There is **no** `max-height`, no `overflow` on the editor, and no redeclaration of `--dsh-composer-text-max-height` — any of those turns "the second line" into scrolling: the caret sits on line 2, the scroll follows the caret, line 1 is pushed out of a box that never grew, and it looks like "line 1 vanished and line 2 moved into its place". That trap was stepped in once in 0.9.1; the tests now pin those three things away.

The card's top padding and gap are tightened too (8→6, 12→6); the button row below (model picker, Send/Stop) is untouched — it is not ours. To make the input exactly like the main composer (36px at rest), delete the `min-height` and `inset` rules.

### One button while running

While the main conversation runs, its primary button **becomes** Stop. The side pane drives a child Session, and the shipped composer does not do that swap for children (`primaryStops` requires `subagent === null`) — instead a second Stop **appears next to** Send (`interruptible = running && continuable`). Submitting clears the draft, so Send sits disabled — the side pane then shows "Stop + a greyed-out Send", which looks like a broken button.

`SIDEBAR_CSS` hides the trailing one only in exactly that state: when the row-end container holds **two adjacent buttons** and the last one is `[disabled]`. Start typing and the rule stops matching, so the button comes back on its own. The test uses attribute selectors and row structure only, never build-time hashed class names; if the shipped DOM becomes nested, the rule simply stops matching instead of hiding the wrong button.

### The input placeholder

The placeholder is real rendered text (`[data-composer-placeholder]`, a sibling of the editable area), so CSS cannot replace it. The approach: shrink the original to `font-size: 0` and paint our own with `::before`.

> ask me anything you wanna know~

This only applies while the input is usable. When it is unavailable / offline / blocked the original text is **state**, not decoration, and those rules put it back — the test is `aria-disabled="true"` on the editable area in the same parent. The accessibility name still comes from the original `aria-label` in every case (screen readers hear the official sentence, with the `/` and `@` hints).

**Why CSS instead of taking over the `conversation.composer` chain.** That chain is the official extension point for "replace this Session's input area", but its `select` only receives the Session: taking it over would also change the input when the child Session is opened in the main view, and it would hide the resident input area (which holds pending approvals and the Stop button). CSS only changes the look, never the behaviour.

**Why not change the placeholder in the locale.** That would change the main conversation's input too, and the main one needs the `/` and `@` hints; the side pane wants the tone of a chat, not a global rewrite.

### The opener: behaviour does not travel through the dialog

Creating an assistant posts a `hello`. It is not a prompt, it is **ignition**: DSH opens a Session's first turn with the first message.

The side assistant's **behaviour** comes from the Session's agent composition, not from the dialog:

| Carrier | Where it lands |
| --- | --- |
| `persona` | This Session's scoped `deployment:persona-prefix` section — it only covers this Session |
| `denyTools` | This Session's scoped `tools.restrict()`: a removed tool is neither in the prompt nor callable |
| `reasoningEffort` | `agentOptions` at creation, persisted with `subagent/descriptor` |

So the pane reads like "an assistant, not a user who pasted a prompt". The cost is that `hello` is still a real user message and shows up as a user bubble — see [Known boundaries](#known-boundaries) item 11. To get rid of it, configure `opener: ""`: the Session opens on an empty conversation and waits for you to speak first.

**The pane does not wait for the opener.** `/side-assistant/ensure` answers as soon as the Session exists and the greeting has been posted; that turn finishes in the background and only then flushes and releases the agent. So "press the button → pane appears" costs no model round trip: the pane opens first, the reply streams in after, and you can already type (messages queue behind the greeting).

## Ready before you click

The side assistant is not a "click and only then start" thing — the in-pane button appears with the Session header, the page then waits half a second and asks the Host to **pre-build** this Session's side assistant (`POST /side-assistant/preload`). By the time you click, only a lookup remains: the Session is already in the list, and the pane goes straight to the conversation.

It picks the cheap path:

- **An existing assistant is reused**, never rebuilt — so switching and reopening does not pile them up.
- **Only in a Session you are really in.** The request carries a single `sessionId`; the Host first checks whether that Session has a resident agent and skips otherwise (`skipped: "parent-not-live"`) — such a Session could not own a side assistant anyway, and should not create one.
- **Half a second of debounce.** Merely passing through a Session should not leave an assistant behind.
- **The opener still runs in the background**, unawaited; by the time the pane opens you may already be able to type.

The cost is real: **every Session you linger in gets a pre-built side assistant** (a Session log plus one greeting model call). Set `preload: false` to turn that off and go back to "created when clicked".

---

## The progress strip: what the main Agent is thinking

The strip at the top of the pane is a **read-only observation window**; all its data comes from the framework's own Session stream:

| What you see | Where it comes from |
| --- | --- |
| `tool name` + argument summary, tool result (errors in red) | the main Session's durable `tool/call` / `tool/result` events |
| Each step's **chain of thought** (live while streaming, kept greyed once done) | `reasoning-delta` chunks of `assistantStream`, and the `stream` inside `assistant/message` |
| The end of the turn | `turn/start` / `turn/end` |
| The dot: `idle / live / unreadable` | whether the stream is alive |

**The chain of thought is kept, not flashed away.** Each step of the main Agent gets its own block: the one being written is marked `live` (highlighted left border), the step turns it `done` when it ends (greyed but kept), and the next step does not overwrite it — so after a turn finishes, the last few steps' thoughts are still there when you open the pane. Two backfills happen automatically:

- **The pane was opened mid-step**: the snapshot frame of `session.follow` carries `assistantStream.activeAttempt`, i.e. the compact prefix of "what this attempt has streamed so far". Opening expands it, cuts it at `nextIndex` to the published part, and fills in from the beginning of the step before switching to deltas — not "starting to record at the moment you opened".
- **A step had already finished when the pane opened**: that step's durable `assistant/message` event carries the whole `stream`, and reasoning is recovered from it. Historical events in the snapshot take the same path, so the first thing you see when the pane opens includes earlier steps' thoughts.

Limits: at most 6 thought blocks (4000 characters each, truncated from the front so the conclusion survives), 30 tool rows; blocks and rows have separate budgets, so a tool-heavy turn cannot push the thoughts out. Unfolded, it follows the bottom automatically, and stops following once you scroll up yourself.

**Folded by default.** An unfolded strip — step rows plus chains of thought — is dozens of lines tall, and it shows the same thing you already see in the main view: duplicating it in the sidebar only pushes the chat out of the way. So the pane opens it as a single line: a status dot, `主 Agent 进展`, **a preview of the newest thought** (you can see what it is thinking even folded), a chevron. Unfold on demand; the choice is remembered for the life of the page (`progressOpen` in `client.js`: surviving Session switches and remounts, back to folded after a refresh).

What folds is the **display**, not the subscription: `session.follow` stays connected, the dot still blinks, and an unreadable stream still shows "进展读不到，看看控制台" on that line — so a folded strip never hides a failure.

It is implemented with `ctx.remote.session.follow({ "address": { kind: "session", sessionId: main Session }, assistantStream: true })`: one subscription yields the snapshot (events that already happened plus the compact prefix of the running attempt) and every delta after it, and it disconnects when the pane closes. Expanding the compact stream records (`reasoning-chunks` → individual deltas) is reimplemented locally, because the framework's helper is not on the `require` face of the browser half.

**Those blocks also reach the side assistant — through the system prompt, not the chat log.** Every time the main Agent finishes a step, the Host folds that step into a block (conclusion + tool calls + thought) and mounts it into the side assistant Session's system-prompt fragment `side-assistant:progress` (order 125, right after the delegation statement). The first line of each block is a **one-sentence conclusion**: the first sentence of the step's own closing text, or — when the step only ran tools — an action summary such as "Conclusion: this step only used tools (read, bash) …". Tool actions come next and the raw thoughts last: conclusion first, detail after, so "what is it doing now" gets a sentence instead of a wall of thinking. With several blocks in hand it walks them oldest to newest (one sentence each) and lands on the newest, so what you see is "first it did this, then that, and now it is here" rather than a pile of parallel fragments. Blocks never enter the log: the pane still holds only your conversation with the assistant, and the history summary still stops at creation time (see [Known boundaries](#known-boundaries) item 1).

Limits and cost: at most 4 blocks (200 characters of thought, 120 of conclusion, 3 tools × 60 characters each per block; older ones roll off). A full injection is usually a few hundred characters — deliberately: a long injection crowds out what you actually want to discuss and turns "see it at a glance" into reading a report. Each block change changes the system prompt, so the prompt cache is invalidated — a deliberate trade: live progress beats cache hits. The fragment text is a getter, recomputed at every prompt assembly, so a step that landed after you asked but before the model spoke is already in there.

### Deleting an assistant: in the menu, archive first, then close the tab

The delete control lives next to the thing it deletes: press the header button again to open the menu and every `助手 N` row has a **Delete** on its right — two characters, paid for out of the row's width instead of the progress strip, and no "which assistant does the button at the right end delete?" to remember. The label follows the system language (`删除` in `zh`, `Delete` in `en`).

Two-step: the press turns it into **Confirm**, and only a second press acts; four seconds without one and it gives up by itself (a stray click cannot be completed half an hour later). Deleting goes through the framework's workspace archive (`workspaces.archiveSession`, with `stopActivity`):

- **It disappears from the menu.** The Host subtracts the archive set when listing, so a deleted assistant is never reopened by `ensure({})`; the next press creates a new one, and the remaining rows renumber (`助手 1`, `助手 2`, …).
- **The tab closes.** The menu knows a child Session id but not which tab renders it — tab ids belong to the dock. So the pane records the pair in `openTabs` (`client.js`) on mount and forgets it on unmount; deleting looks it up and closes the tab if that assistant is the one on screen (otherwise what is left is an empty shell).
- **The log stays.** Archiving is not erasing: the Session record stays on disk and can be restored from the workspace's archived list (after restoring it shows up in the menu again, because it is once more "detached lineage + current composition + uncatalogued").
- **Failures speak.** If archiving fails that row turns into `删除失败`, the row and its tab stay put, and another press retries (details in the console).

Deliberately not done: no batch delete, no confirmation dialog (the confirmation lives on the button itself — one click fewer, one misclick safer), and no use of the `sidebar.right.tab.menu.item` slot — that slot only shows up in a tab's own dropdown, and this pane's tab header lives in the collapsed rail, which is buried too deep; the menu row is where the user already goes.

---

## The shortcut cards under the answer

Under the last answer and above the input sit two rounded rectangles:

- **What is this project about?**
- **What is the agent working on?**

A click sends the sentence through `conversation.send()` — the same path the composer's send button
uses — so a normal user bubble appears and a normal turn follows (queued if a turn is running).

They hang off the Session's own `conversation.input.dock` slot (the queue bar and the todo bar live
there too), which is why their place is naturally "under the answer, above the input". That slot is
**shared by every conversation view**, so two CSS rules keep the default state `display: none` and
switch to `display: flex` only under an ancestor carrying `[data-sidebar-chat]` — i.e. only inside
this pane. The main conversation shows nothing at all.

That slot used to be hidden wholesale by the composer trim (the same rule took out the git branch
row, the quota strip and the queue bar). Since 0.11.2 the rule hides **only the other children**:
`[data-sidebar-chat] [data-slot="conversation.input.dock"] > *:not(:has(.dsh-sa-cards))`. The cards
are direct children of the anchor, so they stay; every other entry (git row, quota, queue, todo) is
still kept out of the pane.

## Configuration

The `config` in `cordis.patch.yml` is passed to `apply(ctx, config)` unchanged; every key is optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `label` | `侧边助手` | The menu label, also written into the Session descriptor (**no longer an identity key**, see [How it works](#how-it-works)) |
| `opener` | `hello` | The message that opens a new assistant's first turn. **Use it only as a greeting, never for instructions** — DSH delivers it as a plain user message, so instructions here mean "the user typed the prompt themselves". Empty string = no greeting |
| `persona` | the side assistant's behaviour rules (English; the rules say "answer in the language the user writes in") | The assistant's **behaviour**: injected as a scoped persona prefix; **do not write `{{…}}`**, it is interpolated as a template |
| `denyTools` | `[send_message]` | Tools **removed** from the Session's composition. A removed tool is neither in its prompt nor callable. Empty array = no restriction |
| `reasoningEffort` | `off` | The assistant's thinking level. Off by default (a side question is something you are waiting for; no thinking mode); set `low` / `high` / `max` to enable, or `inherit` to pass nothing at all and inherit the main Session's routing |
| `preload` | `true` | After you linger half a second in a Session, build its side assistant ahead of time, moving the "copy the history" step before the click (see [Ready before you click](#ready-before-you-click)). `false` disables it |

Example:

```yaml
- insert:
    - id: side-assistant
      name: dsh-side-assistant
      config:
        label: 我的助手
        reasoningEffort: low   # enable thinking like this
        denyTools: [send_message, shell]
```

---

## How it works

Two halves, one entry point.

```
Host  index.js                              Browser  client.js
  POST /side-assistant/list                  header button (order -15)
    ├─ sessionQuery.listSessions()             a press → POST /list
    │    keep parentSession = this Session            ├─ empty list → POST /ensure {sessionId}
    │    + origin = subagent                          └─ non-empty  → open the menu
    └─ minus subagents.listChildren() (real         Assistant i → /ensure {sessionId, childId}
       delegations)                                   New assistant → /ensure {sessionId, create:true}
       ⇒ what remains is a free-standing                         ↓
         side assistant                        sidebarRight.openResource(
         sorted oldest to newest                  dsh-resource://sideassistant/chat/
  POST /side-assistant/ensure                     <child>?parent=<parent>)
    ├─ { sessionId }  the current one                              ↓
    ├─ { childId }    reopen that one                its own tab = progress strip
    ├─ { create:true } always a new one              + the shipped conversation view
    └─ otherwise: reuse the newest
       → { childId, created }                  create: agents.create({
                                                 no parentAgent,
                                                 meta.parentSession,
                                                 history: summary text,
                                                 setup: descriptor + composition
                                               })
```

- **Creation must go through the Host.** The client's `subagents` remote namespace only exposes `prompt` and `interruptByParent`; there is no create.
- **`agents.create()` without `parentAgent` ⇒ the runtime treats it as a root agent.** That is not laziness, it is the requirement: a subagent's identity comes from a **`subagent/catalog` fact in the parent's log** (`listChildren` / counts / Session tree / `list_agents` all read it). Without appending that fact, nothing anywhere would count it as a subagent.
- **Why keep `origin: 'subagent'` + `parentSession` then.** The side chat has to address and drive this Session: address validation requires `origin === 'subagent'` with a matching `parentSession`, and requires the Session's **own log to contain `subagent/descriptor`**; delivering a message cold-resumes from that descriptor (`coldResume()`: `mode` must be `continuable`, everything else is rebuilt from it). In other words, those two fields are an **interface for the sidebar**, not a registration with the subagent system.
- **`setup` is the creation window.** `agents.create()`'s `setup(childCtx, child)` runs after the Session and agent are inserted but before they are published — the framework itself appends the descriptor here. Four things happen: append `subagent/descriptor` (v3: `version / mode / provider / label / agentProvider / agentModel / agentReasoningEffort / persona / toolFilter`; unknown keys throw), inherit the sandbox and approval policy (pinning approval to `never`, like the old delegation path), `agentPresets.composeFrom()` to join the parent's composition, and the scoped persona section + `tools.restrict()`.
- **Wrapping up: flush, then `dispose()`.** `AgentHandle.dispose()` only unregisters the Session from the runtime and stops the loop — **it does not touch the log**. So create, `sessions.flush()`, dispose, and every later question goes through cold resume. (Unloading the plugin must **not** dispose: that would delete the Session with it.)
- **Discovery works by subtraction.** Of the Sessions in `sessionQuery.listSessions()` whose `parentSession` points at this Session and whose `origin === 'subagent'`, subtract those in `subagents.listChildren()` — what remains is a free-standing side assistant; then subtract the workspace archive set (`workspaceRegistry.archivedSessionIds`), so deleted ones do not come back. That is why `label` is no longer an identity key (before 0.6 renaming an assistant meant getting a different one; now it only changes the display). A second gate is the `COMPOSITION_SINCE` constant in `index.js`: anything created before it does not count — including the 0.7-era side assistants that were **real subagents**; most of them are catalogued too, so both gates catch them.
- **Quota.** It no longer takes a continuable slot (that is the activation table's business, and only the delegation path fills it). The only limit it can still hit is **the question turn**: a cold resume temporarily needs an activation slot (the framework's `maxActiveSubagents`, default 8), and when that is exhausted the framework's own error appears in the pane (`subagent limit reached …`).
- **The address is a contract, not string concatenation.** This plugin has its own protocol and tab type (`sideassistant` / `dsh-resource://sideassistant/chat/<child>?parent=<parent>`), **mutually exclusive** with the shipped `subagentchat` syntax: parsing the other's address must fail, so neither steals the other's tab. `test/address.contract.mjs` validates that contract along with the glob, encoding and rejection samples.
- **How progress blocks reach the model.** The Host subscribes to the main Session's `session/event` (`tool/call` / `tool/result` / `assistant/message`), folds each finished step into a block, and writes it into the side assistant Session's system-prompt fragment `side-assistant:progress`. Registration hangs on `agent/created`, because every question to a side assistant is another cold resume (a fresh agent context), so registering once at creation would not do. **The history summary hangs on the same hook** (`side-assistant:history`, order 120, ahead of the blocks): a cold resume rebuilds only `persona` and `toolFilter` from the descriptor, so anything registered in the creation window is gone — the summary is static text kept on the Host's `progress` record and re-attached with the blocks, otherwise the assistant would "forget" the conversation the moment the user typed. Blocks are attributed by parent Session id only (`parentSession` lineage); another Session's events never get in. Who receives blocks: newly created assistants, ones opened from the menu, and the batch the Host scans at startup (`adoptExisting()`, with the same criteria as the menu: detached lineage + current composition + not in the parent's delegation catalog) — so after a restart you can type straight into a restored tab and still get the blocks accumulated since the restart.
- **Thinking is off by default (`reasoningEffort: "off"`).** A side question is something the user is waiting for, and the assistant does not have to plan a task; turning it off saves the whole thinking generation time, so the first sentence (and every greeting) is faster. It overrides effort only, never provider/model (the framework's `resolveChildAgentOptions()` has a rule: switching routing without naming an effort loses the inherited effort). The value is also written into the descriptor (`agentReasoningEffort`), so a cold resume does not fall back; writing `low` / `high` / `max` in the config turns it on, and `inherit` leaves the main Session's routing untouched.

## Known boundaries

1. **History is a summary; progress is a stream.** The assistant no longer copies the main conversation: at creation everything up to the last `turn/end` is folded into one summary (the user's questions and the main agent's answers, each clipped, the whole thing bounded, newest kept), mounted as the prompt context `side-assistant:history`. So the pane opens on a clean conversation while the assistant still knows what was discussed — but the summary is **compressed**, and it should not pretend to remember exact wording. Progress after that point arrives as blocks in the system prompt (see [The progress strip](#the-progress-strip-what-the-main-agent-is-thinking)).
2. **The turn running in the main Session does not enter the summary.** An unclosed turn has no conclusion to summarise; the progress blocks cover it.
3. **A Session with no completed turns** can still own a side assistant; it simply starts from zero history (no error).
4. **One main Session can have several side assistants, identified only by lineage + being uncatalogued, never by `label`.** Menu numbers follow creation order; after deleting one in the middle the later ones shift up (the deleted one no longer lists). Real delegation subagents are never mistaken for assistants — they are in the catalog, and the first gate filters them out.
5. **`persona` / `denyTools` / `reasoningEffort` are fixed at creation.** They go into the Session's agent composition and cannot be changed afterwards (the descriptor is in the log and theoretically readable, but the plugin does not intend to depend on its schema being stable). To invalidate old assistants after a config change, push `COMPOSITION_SINCE` in `index.js` to a new instant.
6. **Deleting is archiving, not erasing.** The `Delete` control on each row of the menu calls the workspace's `archiveSession`: the Session disappears from the menu and the workspace list and the tab closes, but the log stays on disk and can be restored from the archived list. It never enters the Session tree, so there is no "remove a subagent from the parent" path — after restoring it counts again as "detached lineage + current composition + uncatalogued" and shows up in the menu. To destroy the log for good you have to delete the record in DSH's Session storage by hand.
7. **It depends on the shipped conversation view and right sidebar.** The chat itself comes from `dsh-client-ui-conversation`'s `conversation.content` factory (`dsh-client-ui-chat` draws the message stream) and the tab from `ui-sidebar-right`; disable them and the pane either fails to open or keeps only the progress strip. Nothing crashes when they are missing: the pane services are requested separately with `ctx.inject`, and a failing chat area shows a line "侧边对话加载失败" instead of a blank.
8. **It stays out of the Session list.** Sessions with `origin === 'subagent'` are already filtered out of the workspace list, which is exactly what we want: zero pollution.
9. **The input trim rests on two DOM contracts**: `data-sidebar-chat` on the pane root (now set by this plugin) and the slot anchors `div[data-slot="<slot>"]`. If the former breaks, only the reach of the trim rules changes; the latter is an external contract (a renderer setting, `display: contents`, and DSH's own stylesheet selects on it), worth a second look on a major DSH upgrade. The failure mode is "some controls are back", never an error and never a broken feature. The same goes for the message action row and the placeholder, which also depend on `data-actions-reveal` (assistant footers only), `data-composer-placeholder` and the editor's `aria-disabled` — all rendering details of `dsh-client-ui-chat` / `dsh-client-ui-conversation`, likelier to change than slot names. Their failure modes are "the buttons are back" and "the placeholder is the official one again", neither of which breaks anything.
10. **The placeholder yields only when the input is unavailable / offline / blocked.** Plan mode and steer-queueing also show `ask me anything you wanna know~` — they are not errors, but they are not what this pane is about; to keep their original text too, loosen the condition of the two `:has(> [data-placeholder][aria-disabled="true"])` rules in `SIDEBAR_CSS`.
11. **The opener `hello` shows up as a user bubble.** It is a real user message (DSH delivers it that way and the plugin cannot change the role) and the pane renders this Session's record. Its log now starts at that greeting (history is a summary, not a seed), so "the first user bubble" *is* the opener and a positional hide would be safe — the plugin still does not hide it; configure `opener: ""` if you do not want it.
12. **Thinking levels are adapter-specific.** The DeepSeek adapter accepts `off | low | high | max`; the plugin does not validate. An unsupported value makes **Session creation fail** with `UNSUPPORTED_REASONING_EFFORT` — set `inherit` then. To change an existing assistant mid-flight, use the model picker in the pane (it carries effort levels).
13. **The menu asks again on every press; nothing is cached.** Create or delete an assistant in another tab and the next press shows it without a refresh. The cost is one `POST /side-assistant/list` per click; it reads the Session index and this layer's catalog, not Session logs.
14. **The menu opens from "one assistant already exists", not "more than one".** The literal request was "take effect once there is more than one assistant", but implementing >1 would make "New assistant" unreachable when exactly one remains — one entry point fewer. So "New assistant" sits at the end of the menu and no assistants at all means direct creation. For a strict >1, change `if (rows.length === 0)` in `client.js` to `if (rows.length < 2)`, at the cost of not being able to create another while exactly one remains.
15. **The menu and the strip are hand-drawn, using theme tokens only.** They do not use the `@deepseek-ai/dsh-client-ui-primitives` dropdown (plain JS plugins may not require Harness Client packages), so they follow `--dsw-*` variables rather than component-library behaviour.
16. **The approval policy is pinned to `never` inside the creation window** (the same semantics as the old delegation path): a side assistant should not do things that need your approval. When it does try, it gets a refusal instead of an approval prompt dangling in the sidebar. To loosen it, change `capturePolicyOverrides()` / `appendPolicyOverrides()` in `index.js`.
17. **The strip only subscribes while the pane is open**; when the main Session is closed or archived it shows "unreadable" instead of erroring, and it does not subscribe to the side assistant's own Session (the chat below already shows that). Folding only changes the display: the subscription stays, and the dot and the "unreadable" line keep updating. Retention is bounded: 6 thought blocks × 4000 characters, 30 tool rows, older ones roll off; after a remount the strip backfills from "the last few steps in the snapshot", and anything earlier was never in the sidebar to begin with (the main view's own record still has it).
18. **The fold preference is not persisted.** It lives in a module variable in `client.js`, so a refresh returns to folded; using `localStorage` would add a piece of durable state that needs cleaning up for a pure UI detail — not worth it yet.
19. **Progress blocks live in memory only, and only in one direction.** The block table is a `Map` in `index.js`; a Host restart empties it (the assistant is still there, only "new progress from now on" starts accumulating again). Every block is bounded (200 characters of thought, 120 of conclusion, 3 tools × 60 characters), at most 4 blocks, older ones roll off; the conclusion is the first sentence of that step's text, not a summary the model rewrote. A block holds no user words from the main Session and no turn boundaries, only the steps the main Agent walked after the assistant was created (or adopted from the menu). Cold resume behaves the same: every question re-mounts the fragment, so the first question after a restart sees the blocks accumulated since the restart.
20. **The input starts one line tall and scrolls inside the box past 336px.** It starts one line shorter than the main composer; growth, ceiling and scrolling all match afterwards. To make it identical, delete the `min-height` and `inset` rules in `SIDEBAR_CSS`.

## Tests

No test framework; run them directly:

```sh
node test/host.smoke.mjs        # Host half: routes, idempotency, concurrent collapse, creation window, progress blocks, error branches
node test/client.smoke.mjs      # Client half: factory contract, slot/resource/tab registration, address, menu, progress strip
node test/address.contract.mjs  # Address contract: own syntax, standalone URL reading, exclusivity with the shipped subagentchat
```

All three use fake Contexts, a fake DOM and fake fetch, so DSH does not have to be running. `client.smoke.mjs` carries a few-dozen-line hook runtime (respecting dependency arrays, able to mount and unmount effects) that really renders buttons and the pane, presses them, and feeds fake `session.follow` frames — so every branch of the menu and the strip is behaviour-verified rather than string-asserted. `address.contract.mjs` finds the local DSH install on its own and cross-checks the exclusivity of the two syntaxes; if it cannot find one it only runs the local syntax (force a path with `DSH_SUBAGENT_CLIENT=<…>/dsh-client-ui-subagent/lib/client.js`).

## License

Copyright (C) 2026 the dsh-side-assistant authors.

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License, version 3** (AGPL-3.0), as published by the Free Software Foundation — either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but **without any warranty**; without even the implied warranty of merchantability or fitness for a particular purpose. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program (see [LICENSE](LICENSE)). If not, see <https://www.gnu.org/licenses/>.

Because this is AGPL-3.0, running a modified version as a network service obliges you to offer its users the corresponding source: the plugin is meant to be run as part of a DSH web interface, so that obligation applies to the plugin code you run, not only to copies you distribute.
