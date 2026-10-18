/**
 * Browser half of `side-assistant`.
 *
 * One conversation-header button. Pressing it asks the Host half for this
 * Session's side assistant (a detached Session, created on first press and
 * reused afterwards) and then opens it in the right sidebar.
 *
 * The panel has two parts:
 *
 * 1. **The main Agent's live progress.** A long main turn should not be a black
 *    box, so the panel follows the main Session's own stream — turn boundaries,
 *    tool calls and results as durable events, plus the live reasoning deltas of
 *    the attempt in flight. This half reads that stream from the Host through
 *    the Session remote (`session.follow` with `assistantStream`), the same face
 *    the History and Plan tabs use. It sits above the chat as a ONE-LINE strip
 *    and starts folded: the main interface already shows that progress while the
 *    user watches it, so the pane spends its height on the conversation and the
 *    strip is there for the moment the user steps away from the main view.
 *
 * 2. **The chat itself**, which is NOT implemented here. `dsh-client-ui-subagent`
 *    ships the shared Conversation factory for a subagent-addressed Session —
 *    composer, streaming, Stop, paging — registered globally under the
 *    `sidebar.chat.conversation` seat. This half therefore only declares a tab
 *    body of its own, binds the Session it was opened for, and renders that
 *    seat: no chat code is duplicated, and any future composer improvement
 *    applies here too.
 *
 * The tab body is our own rather than the shipped `subagentchat` one because
 * the progress strip has to sit ABOVE the chat: `conversation.header` is only
 * rendered by the main conversation panel (never in an embedded sidebar pane)
 * and the chat view renders no pane-level strip, so there is no seat to elect.
 *
 * The resource address is built by hand rather than by requiring
 * `@deepseek-ai/dsh-client-ui-subagent`: plain-JavaScript plugins must not
 * import Harness Client packages (their APIs change without a type check here),
 * and the address grammar is a stable, parsed contract.
 *
 * Reusing the shipped chat also means inheriting the MAIN conversation's
 * composer, so every composer extension the installed plugins add came along
 * into the side panel too. `SIDEBAR_CSS` below trims the pane back to a plain
 * input box and pins that box to one line, so it reads as the side assistant's
 * box rather than a second main composer; see its comment for why that is done
 * with scoped CSS rather than by taking over the `conversation.composer` chain.
 */
window.__ModuleLoader__.load({
  id: 'dsh-side-assistant',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace for the button's copy. */
    const NS = 'sideAssistant'

    const zh = {
      label: '侧边助手',
      open: '打开侧边助手：继承本会话历史，可反复追问，不影响主任务',
      busy: '准备中…',
      failed: '侧边助手打不开，看看控制台',
      choose: '选择侧边助手',
      assistant: '助手',
      create: '新建助手',
      progress: '主 Agent 进展',
      progressEmpty: '等待主 Agent 的下一步…',
      progressFailed: '进展读不到，看看控制台',
      progressFold: '收起进展',
      progressOpen: '展开进展',
      turnStart: '开始新一轮',
      turnEnd: '本轮结束',
      chatFailed: '侧边对话加载失败',
      delete: '删除',
      deleteConfirm: '确认',
      deleteFailed: '删除失败',
      askProject: '这个项目是在干什么？',
      askWork: 'agent 正在进行什么工作？',
      askFailed: '发送失败，看看控制台',
      // Settings page (Settings → Plugins). It lives outside the panel, so its
      // copy names the page itself rather than reusing the pane's labels.
      title: '侧边助手',
      settingsIntro: '模型、上下文预算和回答风格都在这里设置；保存后新开的对话即按新设置工作。',
      settingsModel: '模型',
      settingsModeInherit: '跟随主会话',
      settingsModeHost: '指定宿主模型',
      settingsModeCustom: '自定义端点',
      settingsProvider: 'provider',
      settingsModelName: '模型',
      settingsHostHint: '填宿主已配置的 provider / model（在 设置 → 模型 里配置）',
      settingsBaseURL: 'Base URL',
      settingsCustomModel: '模型',
      settingsApiKey: 'API Key',
      settingsApiKeyConfigured: '已配置',
      settingsApiKeyKeep: '留空表示不改',
      settingsApiKeyPlaceholder: 'sk-…',
      settingsCustomHint: 'OpenAI 兼容端点：宿主会把它注册成一个名为 side-assistant-custom 的 provider',
      settingsContext: '上下文',
      settingsSteps: '进度保留的完整 step 条数',
      settingsTokens: '上下文预算上限（token）',
      settingsStyle: '回答风格',
      settingsStyleBrief: '简约',
      settingsStyleDetailed: '详细',
      settingsIdentity: '助手',
      settingsLabel: '助手名',
      settingsOpener: '开场白',
      settingsSave: '保存',
      settingsSaving: '保存中…',
      settingsSaved: '已保存',
      settingsTest: '测试连接',
      settingsTesting: '测试中…',
      settingsPingOk: '连接正常',
      settingsLoadFailed: '读不到当前设置，先用默认值',
      description: '在右侧栏里开一个围绕当前对话的子 agent；模型、上下文预算和回答风格都在这里调整',
    }

    const en = {
      label: 'Side assistant',
      open: 'Open the side assistant: inherits this session’s history, safe to keep asking',
      busy: 'Preparing…',
      failed: 'Could not open the side assistant',
      choose: 'Choose a side assistant',
      assistant: 'Assistant',
      create: 'New assistant',
      progress: 'Main agent progress',
      progressEmpty: 'Waiting for the main agent…',
      progressFailed: 'Could not read the progress stream',
      progressFold: 'Hide progress',
      progressOpen: 'Show progress',
      turnStart: 'New turn',
      turnEnd: 'Turn finished',
      chatFailed: 'Could not load the side conversation',
      delete: 'Delete',
      deleteConfirm: 'Confirm',
      deleteFailed: 'Delete failed',
      askProject: 'What is this project about?',
      askWork: 'What is the agent working on?',
      askFailed: 'Could not send, see the console',
      title: 'Side assistant',
      settingsIntro: 'Model, context budget and answer style; saved changes apply to new conversations.',
      settingsModel: 'Model',
      settingsModeInherit: 'Follow the main session',
      settingsModeHost: 'Use a host model',
      settingsModeCustom: 'Custom endpoint',
      settingsProvider: 'Provider',
      settingsModelName: 'Model',
      settingsHostHint: 'Give a provider / model the host already has (configure it in Settings → Models)',
      settingsBaseURL: 'Base URL',
      settingsCustomModel: 'Model',
      settingsApiKey: 'API key',
      settingsApiKeyConfigured: 'Configured',
      settingsApiKeyKeep: 'Leave blank to keep',
      settingsApiKeyPlaceholder: 'sk-…',
      settingsCustomHint: 'OpenAI-compatible endpoint: the host registers it as a provider named side-assistant-custom',
      settingsContext: 'Context',
      settingsSteps: 'Full steps kept in the progress digest',
      settingsTokens: 'Context budget ceiling (tokens)',
      settingsStyle: 'Answer style',
      settingsStyleBrief: 'Brief',
      settingsStyleDetailed: 'Detailed',
      settingsIdentity: 'Assistant',
      settingsLabel: 'Name',
      settingsOpener: 'Opening message',
      settingsSave: 'Save',
      settingsSaving: 'Saving…',
      settingsSaved: 'Saved',
      settingsTest: 'Test connection',
      settingsTesting: 'Testing…',
      settingsPingOk: 'Connection OK',
      settingsLoadFailed: 'Could not read the current settings; showing defaults',
      description: 'A subagent beside the current conversation; its model, context budget and answer style are configured here',
    }

    /** Cordis services this browser half requires. */
    const inject = ['slots', 'sidebarRight', 'sessions', 'remote', 'remote.session', 'locale']

    /**
    /**
     * Services only the panel needs. Registered through `ctx.inject` so a build
     * without the resource registry or the tab registry still gets the button.
     */
    const PANEL_SERVICES = ['resources', 'sidebarRightTabs']

    /** Host routes registered by `index.js`. */
    const ENDPOINT = '/side-assistant/ensure'
    const LIST_ENDPOINT = '/side-assistant/list'
    const PRELOAD_ENDPOINT = '/side-assistant/preload'

    /**
     * How long the header action has to stay mounted before the Host is asked to
     * warm a side assistant.
     *
     * Composing one copies the main history, which is the slow half of a first
     * press — so the ask goes out while the user is still reading, not when they
     * click. The delay keeps session-flipping from composing assistants for
     * Sessions the user only passed through.
     */
    const PRELOAD_DELAY = 500

    /**
     * Sessions this page already asked to warm. One ask per Session is enough:
     * the Host reuses what exists, and re-asking on every remount would just be
     * listings for nothing.
     */
    const preloadedSessions = new Set()

    /**
     * Open panes, by the child Session each one shows.
     *
     * Deleting now lives in the header menu, which knows a child id but not the
     * tab that renders it: the tab id is the dock's, assigned when the pane
     * opens. The pane itself is the only place both are in hand, so it records
     * the pair on mount and forgets it on unmount; the menu closes the matching
     * tab if the deleted assistant happens to be on screen.
     */
    const openTabs = new Map()

    /** Resource protocol and tab kind owned by this plugin. */
    const CHAT_PROTOCOL = 'sideassistant'
    const CHAT_KIND = 'sideassistant'
    const CHAT_ADDRESS = `dsh-resource://${CHAT_PROTOCOL}/chat/`
    const TAB_ID = 'side-assistant/chat'

    /** How many progress rows the panel keeps. */
    const PROGRESS_ROWS = 30

    /**
     * How much chain of thought the strip keeps.
     *
     * Blocks are kept per step, so the user can read what the main Agent
     * thought a moment ago rather than only the line being written right now,
     * and a turn of a real task reaches several steps — six covers the recent
     * past without turning the strip into an unbounded transcript. Each block
     * is clipped to `THOUGHT_CHARS` from the front, so a long reasoning run
     * keeps its conclusion.
     */
    const THOUGHT_BLOCKS = 6
    const THOUGHT_CHARS = 4000

    /**
     * Whether the progress strip is unfolded.
     *
     * Folded by default: the main interface already shows the main Agent working
     * while the user is in it, so in the pane the strip is ambient status, not a
     * second conversation. The choice is remembered for the life of the page —
     * a user who unfolded it once is not asking to redo that on every session
     * switch, and `false` here is what every fresh page starts from.
     */
    let progressOpen = false

    /**
     * POST one JSON body to a Host route and unwrap its `{ ok: … }` envelope.
     * @param path - a route registered by the Host half.
     * @param body - JSON-serializable request body.
     * @returns the parsed payload, with `ok === true`.
     * @throws when the transport fails or the envelope reports a failure.
     */
    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }

      if (!payload || payload.ok !== true) {
        const detail = payload && (payload.message || payload.error)
        throw new Error(detail || `side-assistant: HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * Sidebar address for one side assistant.
     *
     * Carries the main Session id, because the panel follows the MAIN
     * Session's progress and must know it before the child binding resolves.
     * @param childSessionId - the side assistant's Session id.
     * @param parentSessionId - the main Session it hangs off.
     * @returns the `dsh-resource:` address this plugin's tab kind matches.
     */
    function chatAddress(childSessionId, parentSessionId) {
      const query = new URLSearchParams({ parent: parentSessionId })
      return `${CHAT_ADDRESS}${encodeURIComponent(childSessionId)}?${query}`
    }

    /** `dsh-resource://sideassistant/chat/<child>?parent=<parent>`. */
    const CHAT_PATTERN = /^dsh-resource:\/\/sideassistant\/chat\/([^/?#]+)(?:\?([^#]*))?$/

    /**
     * Parse this plugin's chat address.
     * @param address - a resource address as the sidebar passes it back.
     * @returns the retain target plus the main Session id, or `undefined`.
     */
    function parseChatAddress(address) {
      if (typeof address !== 'string') return undefined
      const match = CHAT_PATTERN.exec(address)
      if (match === null) return undefined
      const childSessionId = decodeURIComponent(match[1])
      const parentSessionId = new URLSearchParams(match[2] ?? '').get('parent')
      if (childSessionId === '' || parentSessionId === null || parentSessionId === '') return undefined
      // `mode: continuable` is what lets the chat drive a Session that is not
      // resident: the shipped chat's Send goes through the subagent prompt face.
      return { parentSessionId, childSessionId, mode: 'continuable' }
    }

    /**
     * Resolve when the reader is cancelled. A missing signal means "never" —
     * the resource stays open until the sidebar closes it.
     * @param signal - cancellation owned by the resource carrier.
     * @returns a promise settling only on cancellation.
     */
    function waitForAbort(signal) {
      if (signal === undefined) return new Promise(() => {})
      if (signal.aborted) return Promise.resolve()
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    /**
     * Resource provider for one side assistant.
     *
     * The value is the retained Session reference: `sessions.retain` with an
     * address OBJECT resolves without consulting any catalog, so a detached
     * Session (one that exists only in its own log) binds like any other.
     * @param sessions - the client Session store.
     * @returns a provider for the `sideassistant` protocol.
     */
    function chatResourceProvider(sessions) {
      return {
        protocol: CHAT_PROTOCOL,
        async *open(resourceAddress, { signal }) {
          const address = parseChatAddress(resourceAddress)
          if (address === undefined) {
            throw new Error(`side-assistant: invalid chat resource address ${JSON.stringify(resourceAddress)}`)
          }
          if (signal !== undefined && signal.aborted) return
          // A detached Session has no catalog entry anywhere, so the client
          // cannot tell from lineage that it is not blank — materializing it
          // invents a blank Session and the chat renders its empty shell. One
          // list pull makes the summary (blank: false) available first.
          if (typeof sessions.refresh === 'function') {
            try {
              await sessions.refresh()
            } catch {
              // The binding below reports the real failure.
            }
          }
          const reference = sessions.retain(address, { source: 'sidebarChat', signal })
          try {
            yield { ok: true, value: { address, reference } }
            await waitForAbort(signal)
          } finally {
            reference.release()
          }
        },
      }
    }

    const CSS = `
.side-assistant {
  position: relative;
  display: inline-flex;
}
.side-assistant__action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 3px 7px;
  border: 0;
  border-radius: 6px;
  background: 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}
.side-assistant__action:hover:not(:disabled),
.side-assistant__action:focus-visible {
  color: var(--dsw-alias-label-primary);
}
.side-assistant__action:disabled {
  cursor: default;
  opacity: 0.6;
}
.side-assistant__action[data-state="error"] {
  color: var(--dsw-alias-state-error-primary);
}
.side-assistant__action-icon {
  flex: none;
  display: block;
}
.side-assistant__menu {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 100;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 148px;
  max-width: min(260px, 100vw - 16px);
  margin: 0;
  padding: 3px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-elevation-prominent);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  list-style: none;
}
.side-assistant__menu-item {
  box-sizing: border-box;
  width: 100%;
  min-height: 28px;
  padding: 4px 7px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: 0 0;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 17px;
  text-align: left;
  cursor: pointer;
}
.side-assistant__menu-item:hover:not(:disabled),
.side-assistant__menu-item:focus-visible {
  background: var(--dsw-alias-fill-l1);
}
.side-assistant__menu-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.side-assistant__menu-row > .side-assistant__menu-item {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-assistant__menu-delete {
  flex: none;
  min-height: 22px;
  padding: 2px 6px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm);
  background: 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 15px;
  white-space: nowrap;
  cursor: pointer;
}
.side-assistant__menu-delete:hover,
.side-assistant__menu-delete:focus-visible,
.side-assistant__menu-delete[data-confirming="true"] {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.side-assistant__menu-delete[data-failed="true"] {
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l1);
}
.side-assistant__menu-delete:disabled {
  opacity: 0.6;
  cursor: default;
}
.side-assistant__menu-new {
  margin-top: 2px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 0 0 var(--dsw-radius-sm) var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
}
@media (max-width: 480px) {
  .side-assistant__action-label { display: none; }
}

/*
 * The pane root. The shipped tab root carries this layout; ours is registered
 * by this plugin, so it must set it too — and it must carry
 * data-sidebar-chat, which is the anchor every rule in SIDEBAR_CSS selects.
 */
.side-assistant-pane {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  flex: 1 1 auto;
  align-self: stretch;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.side-assistant-pane__chat {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.side-assistant-pane__chat > * {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.side-assistant-pane__error {
  margin: 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: 1.5;
  word-break: break-word;
}

/*
 * Progress strip. Deliberately small type and a low-contrast frame: it is
 * ambient status, not another conversation.
 */
.dsh-sa-progress {
  flex: none;
  display: flex;
  flex-direction: column;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-fill-l1);
}
.dsh-sa-progress__head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 6px;
}
.dsh-sa-progress__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  min-height: 24px;
  padding: 2px 4px;
  border: 0;
  border-radius: 5px;
  background: 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 15px;
  text-align: left;
  cursor: pointer;
}
.dsh-sa-progress__toggle:hover,
.dsh-sa-progress__toggle:focus-visible {
  color: var(--dsw-alias-label-primary);
}
.dsh-sa-progress__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}
.dsh-sa-progress__dot[data-state="live"] {
  background: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary));
  animation: dsh-sa-pulse 1.4s ease-in-out infinite;
}
.dsh-sa-progress__dot[data-state="error"] {
  background: var(--dsw-alias-state-error-primary);
}
@keyframes dsh-sa-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.dsh-sa-progress__chevron {
  flex: none;
  transition: transform 0.12s ease;
}
.dsh-sa-progress[data-open="true"] .dsh-sa-progress__chevron {
  transform: rotate(90deg);
}
.dsh-sa-progress__body {
  max-height: 148px;
  overflow-y: auto;
  padding: 0 6px 6px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sa-progress__empty {
  margin: 2px 4px 4px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sa-progress__row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 1px 4px;
}
.dsh-sa-progress__row--turn {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sa-progress__glyph {
  flex: none;
  width: 9px;
  text-align: center;
}
.dsh-sa-progress__row[data-status="running"] .dsh-sa-progress__glyph {
  color: var(--dsw-alias-label-primary);
}
.dsh-sa-progress__row[data-status="failed"] .dsh-sa-progress__glyph {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-sa-progress__label {
  min-width: 0;
  overflow-wrap: anywhere;
}
.dsh-sa-progress__thinking {
  margin: 3px 4px 0;
  padding-left: 7px;
  border-left: 2px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-sa-progress__thinking[data-status="live"] {
  border-left-color: var(--dsw-alias-state-success-primary, var(--dsw-alias-border-l1));
}
.dsh-sa-progress__thinking[data-status="done"] {
  opacity: 0.72;
}
.dsh-sa-progress__preview {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sa-progress__head .dsh-sa-progress__label {
  flex: none;
}
`

    const STYLE_ID = 'side-assistant/action.css'

    /** Stylesheet identity for the pane-local composer trim. */
    const SIDEBAR_ID = 'side-assistant/sidebar-chat.css'

    /**
     * Stylesheet identity for the Settings page.
     *
     * A separate sheet, not another block in `SIDEBAR_CSS`: that one is anchored
     * on `[data-sidebar-chat]` because it must never leak out of the pane, while
     * this page renders in Settings → Plugins, outside the pane entirely.
     */
    const SETTINGS_ID = 'side-assistant/settings.css'

    /**
     * Slot outlets trimmed out of the side panel's composer.
     *
     * Each is a `div[data-slot="<key>"]` anchor emitted by the slot renderer
     * with `display: contents` (`SlotOutlet` in `dsh-client-ui-renderer`), so
     * `display: none` on the anchor hides the entire subtree.
     */
    const TRIMMED_SLOTS = [
      // "N turns · M steps · {tps} tok/s · cache hit" (ui-chat's `stats` pill)
      // plus the cost meter's own counters.
      'conversation.composer.dock',
      // NOTE: `conversation.input.dock` is NOT hidden here. It is a full-width
      // row above the card (git branch / "未提交的更改：N 个文件", quota strip,
      // the queue bar, the todo bar) AND the slot this plugin's own shortcut
      // cards live in. Hiding the anchor would hide the cards with the clutter,
      // so the pane hides the dock's OTHER children instead — see the
      // `:not(:has(.dsh-sa-cards))` rule below.
      // Draft attachment rail and drop target.
      'conversation.input.attachments',
      // Balance / wallet and other compact leading controls.
      'conversation.input.left',
      // Compact trailing controls contributed by chat plug-ins.
      'conversation.input.right',
      // Activity indicator that expands across the tool row while running.
      'conversation.input.activity',
    ]

    /**
     * Pane-local trim of the reused conversation composer.
     *
     * The side panel renders the SHARED Conversation factory, and slots are
     * global rather than per-pane: a third-party plug-in can neither unregister
     * another plug-in's entry nor ask the factory for a reduced composer
     * (`ConversationContentInputProps` exposes only `variant`/`phase`/`hero`).
     *
     * The supported per-session alternative — electing an entry in the
     * `conversation.composer` chain — was rejected: its `select` sees only the
     * Session, so it would also replace the composer when the child Session is
     * opened in the main view, and it hides the resident composer, which owns
     * the pending-interaction/approval UI and the Stop button.
     *
     * So the trim is CSS, scoped to the pane root. Both anchors are contracts
     * rather than internals: `data-sidebar-chat` is the pane root this plugin
     * sets itself (the shipped chat tab sets the same attribute on its own
     * root), and DSH's own stylesheets already select `[data-slot=...]`
     * wrappers for layout.
     */
    const SIDEBAR_CSS = `
${TRIMMED_SLOTS.map((key) => `[data-sidebar-chat] [data-slot="${key}"]`).join(',\n')} {
  display: none !important;
}

/*
 * The input dock is shared with other plug-ins (queue bar, todo bar, quota
 * strip). Only the shortcut cards below are wanted in the pane, and they are
 * also direct children of this anchor, so hide every direct child that does
 * not contain them. The :has() selector keeps this independent of entry ids and of the
 * order the host renders entries in.
 */
[data-sidebar-chat] [data-slot="conversation.input.dock"] > *:not(:has(.dsh-sa-cards)) {
  display: none !important;
}

/*
 * The two shortcuts under the transcript.
 *
 * They live in the conversation's input dock, which is conversation-wide (the
 * same entry would appear above every composer), so the wrapper is hidden by
 * default and revealed only inside this plugin's pane: data-sidebar-chat is the
 * marker the pane sets on its own root. Rounded rectangles, one row, and they
 * wrap instead of scrolling when the pane is narrow.
 */
.dsh-sa-cards {
  display: none;
}
[data-sidebar-chat] .dsh-sa-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 6px;
}
.dsh-sa-card {
  appearance: none;
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  text-align: left;
  cursor: pointer;
}
.dsh-sa-card:hover:not(:disabled),
.dsh-sa-card:focus-visible {
  border-color: var(--dsw-alias-border-l4);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-sa-card:disabled {
  cursor: default;
  opacity: 0.6;
}
.dsh-sa-cards[data-state="error"] .dsh-sa-card {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-sa-cards__error {
  align-self: center;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

/*
 * The composer's leading tool row is not a slot, so it is anchored on the
 * hidden file input it contains — a DIRECT child of that row — instead of on a
 * hashed class name. Hiding the row removes the "+" upload/command button
 * together with the plan and permission seats; delete this rule to keep those
 * two seats and hide only "+".
 */
[data-sidebar-chat] div:has(> input[type="file"]) {
  display: none !important;
}

/*
 * The assistant action row is a fixed strip the chat view renders itself, not a
 * slot: copy, then the conversation.chat.assistant-actions seat, then branch,
 * then usage and the clock. Only copy / usage / clock are wanted here.
 *
 * - The seat carries every extension action (the feedback thumbs, and
 *   dsh-context's context jump in this profile), so hiding its anchor drops all
 *   of them at once.
 * - data-actions-reveal is emitted by the assistant turn tail alone, so the
 *   branch rule cannot reach a user bubble's row — where the last button IS the
 *   copy button.
 * - button:last-of-type is the branch button: the usage trigger is a button
 *   inside span.endInfo, so it is never a direct child of the row.
 */
[data-sidebar-chat] [data-slot="conversation.chat.assistant-actions"] {
  display: none !important;
}

[data-sidebar-chat] [data-actions-reveal] [data-clock] > button:last-of-type {
  display: none !important;
}

/*
 * A lower floor, not a lower ceiling.
 *
 * The pane is a side chat, so its input starts one line tall where the main
 * composer starts at 36px — the eye reads a slimmer box, and until the first
 * line is full the box is visibly different. Past that it must grow exactly like
 * the main conversation's: one line at a time, up to the shipped ceiling, then
 * the wrapper scrolls. Only the floor moves here.
 *
 * That is why nothing below sets a max-height or touches the scroll wrapper:
 * - the shipped editor's line box is 24px, so min-height 24 (padding-top 0) IS
 *   one line, and each wrapped line adds another 24.
 * - --dsh-composer-text-max-height (declared by the seat inside this pane, 336px)
 *   stays in charge of when the card stops growing. Capping it — or hanging
 *   overflow-y: auto plus a max-height on the editor, as a first attempt did —
 *   makes a full second line scroll instead of growing: the caret is on line 2,
 *   the scroll follows it, and line 1 disappears from a box that never got
 *   taller. That is a wrapped-line bug, not a slim composer.
 * - The placeholder is absolutely placed from the card's padding box, so it
 *   follows the padding change (4px -> 0) instead of floating below the text.
 */
[data-sidebar-chat] [data-composer-card] {
  padding-top: 6px;
  gap: 6px;
}

[data-sidebar-chat] [data-composer-input] {
  min-height: 24px;
  padding: 0 8px 0 14px;
}

[data-sidebar-chat] [data-composer-placeholder] {
  inset: 0 8px auto 14px;
}

/*
 * Composer placeholder. The text is a real rendered node
 * ([data-composer-placeholder], a sibling of the contenteditable), so CSS
 * cannot swap it — but it can hide the original glyphs with font-size 0 and
 * paint ours through ::before. Our own font-size is explicit because the
 * inherited one is the 0 we just set; the line box survives that because the
 * composer card sets line-height as an absolute calc, which inherits as a
 * length rather than re-resolving against the zero font-size.
 *
 * The exemption rule keeps whatever the composer actually says when it is
 * unavailable, offline or blocked: that text is state, not decoration. Those
 * states are exactly the ones marked aria-disabled on the contenteditable,
 * which sits in the same parent as the placeholder — the accessibility name
 * still comes from the original aria-label in every case.
 */
[data-sidebar-chat] [data-composer-placeholder] {
  font-size: 0;
}

[data-sidebar-chat] [data-composer-placeholder]::before {
  content: "ask anything～";
  font-size: var(--dsh-content-font-size, 14px);
}

[data-sidebar-chat] :has(> [data-placeholder][aria-disabled="true"]) > [data-composer-placeholder] {
  font-size: inherit;
}

[data-sidebar-chat] :has(> [data-placeholder][aria-disabled="true"]) > [data-composer-placeholder]::before {
  content: none;
}

/*
 * One button while a turn runs, not two.
 *
 * The main conversation swaps its primary button to Stop while it is running
 * (primaryStops needs subagent === null). A continuable subagent never gets
 * that swap: the shipped composer keeps the primary as Send and adds a second
 * Stop button beside it (interruptible = running && continuable). Since
 * submitting a message clears the draft, the Send is left disabled — so the
 * pane shows Stop plus a dead grey Send that reads like a broken pair.
 *
 * The row's action buttons are the trailing container's last children (the
 * tooltip clones the button, it does not wrap it in an element). Match the
 * row's trailing container through the card, require two adjacent buttons,
 * and hide only the trailing one while it is disabled: the moment there is
 * something to send, the Send is enabled again and the rule stops applying.
 *
 * If the shipped markup ever nests the buttons, this rule simply stops
 * matching instead of hiding the wrong control.
 */
[data-sidebar-chat] [data-composer-card] > div:last-child > div:last-child:has(> button + button) > button:last-child[disabled] {
  display: none;
}
`

    /**
     * Settings → Plugins → side assistant.
     *
     * Every selector is prefixed `dsh-sa-settings-` and is deliberately NOT
     * scoped with `[data-sidebar-chat]`: the page renders in the Settings
     * plugin list, where no sidebar pane exists, so this sheet is installed on
     * its own (see `SETTINGS_ID`) rather than folded into `SIDEBAR_CSS`.
     * Colours and radii come from the theme's alias variables, so the page
     * follows the active light/dark theme instead of hard-coding either.
     */
    const SETTINGS_CSS = `
.dsh-sa-settings {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
  padding: 4px 0 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.dsh-sa-settings-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-sa-settings-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsh-sa-settings-intro {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sa-settings-group {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-sa-settings-group-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sa-settings-field {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  gap: 5px;
  min-width: 0;
}
.dsh-sa-settings-field-label {
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sa-settings-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.dsh-sa-settings-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 30px;
  padding: 5px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  outline: none;
}
.dsh-sa-settings-input:hover {
  border-color: var(--dsw-alias-border-l4);
}
.dsh-sa-settings-input:focus,
.dsh-sa-settings-input:focus-visible {
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-sa-settings-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sa-settings-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-sa-settings-option {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}
.dsh-sa-settings-option:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-sa-settings-option[data-checked="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-label-primary);
}
.dsh-sa-settings-radio {
  flex: none;
  margin: 0;
  accent-color: var(--dsw-alias-state-business-primary);
}
.dsh-sa-settings-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.dsh-sa-settings-badge {
  flex: none;
  margin-bottom: 5px;
  padding: 1px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
}
.dsh-sa-settings-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l4);
}
.dsh-sa-settings-button {
  min-height: 30px;
  padding: 5px 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
}
.dsh-sa-settings-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-sa-settings-button:disabled {
  opacity: 0.6;
  cursor: default;
}
.dsh-sa-settings-button--primary {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}
.dsh-sa-settings-saved {
  color: var(--dsw-alias-state-business-primary);
  font-size: 12px;
}
.dsh-sa-settings-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}
.dsh-sa-settings-probe {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
`

    /**
     * Install one stylesheet once, returning its removal.
     * Runs inside `apply`'s effect so unload removes the tag again.
     * @param id - `data-plugin-css` identity guarding against a second tag.
     * @param text - stylesheet body.
     * @returns disposer that removes the tag this call created.
     */
    function installStyles(id, text) {
      if (typeof document === 'undefined') return () => {}
      const selector = `style[data-plugin-css=${JSON.stringify(id)}]`
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-side-assistant'
      tag.dataset.pluginCss = id
      tag.textContent = text
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /**
     * Header action: resolve this Session's side assistant, then open its panel.
     *
     * One press has two shapes. With no assistant yet there is nothing to
     * choose, so the press creates one and opens it — the same single press as
     * before. Once one exists the press opens a menu instead: the assistants
     * this Session already has, numbered in creation order, plus "新建助手".
     * The list is fetched on every press rather than cached, so an assistant
     * created in another tab (or a Session that disappeared) shows up on the
     * next press without a reload.
     *
     * Receives the standard Session props plus this plugin's injected face.
     */
    function SideAssistantAction({ sessionId, useSession, listSideAssistants, openSideAssistant, deleteSideAssistant, t }) {
      const [menu, setMenu] = React.useState(null)
      const [phase, setPhase] = React.useState('idle')
      const [shift, setShift] = React.useState(0)
      // Deleting is two presses on the same row: `armed` is the child asked
      // about, `busy` the one being deleted, `failed` the one that would not go.
      const [armedChild, setArmedChild] = React.useState(null)
      const [deletingChild, setDeletingChild] = React.useState(null)
      const [failedChild, setFailedChild] = React.useState(null)
      const rootRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const alive = React.useRef(true)
      const armTimer = React.useRef(null)

      const disarm = React.useCallback(() => {
        if (armTimer.current !== null) {
          clearTimeout(armTimer.current)
          armTimer.current = null
        }
        setArmedChild(null)
      }, [])

      React.useEffect(() => () => {
        if (armTimer.current !== null) clearTimeout(armTimer.current)
      }, [])

      React.useEffect(() => () => {
        alive.current = false
      }, [])

      // A subagent Session shows its own header too; the side assistant always
      // belongs to the top-level (lead) Session the user is really working in.
      const parentSessionId = (typeof useSession === 'function'
        ? useSession((snapshot) => snapshot.subagent?.address.parentSessionId)
        : undefined) ?? sessionId

      // Warm the Host while the user is still reading: a first press should open
      // on a Session that already exists. Failure is silent by design — preloading
      // is an optimisation, and the press path still creates on demand.
      React.useEffect(() => {
        if (parentSessionId === undefined || preloadedSessions.has(parentSessionId)) return undefined
        const timer = setTimeout(() => {
          preloadedSessions.add(parentSessionId)
          Promise.resolve(post(PRELOAD_ENDPOINT, { sessionId: parentSessionId }))
            .catch(() => undefined)
        }, PRELOAD_DELAY)
        return () => clearTimeout(timer)
      }, [parentSessionId])

      // Dismiss on an outside press or Escape. `useDismissOnOutsidePointer` in
      // the UI primitives package does the same thing, but a plain-JavaScript
      // plugin must not import Harness Client packages: their APIs change
      // without a type check on this side.
      React.useEffect(() => {
        if (menu === null) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return
          setMenu(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [menu])

      // Keep the menu inside the viewport: the action sits near the left edge of
      // a header that can be narrow, so clamp against both margins.
      React.useLayoutEffect(() => {
        if (menu === null) {
          setShift(0)
          return undefined
        }
        const fit = () => {
          const root = rootRef.current
          const list = menuRef.current
          /* v8 ignore next -- both refs are attached while the open menu renders. */
          if (root === null || list === null) return
          const width = list.offsetWidth
          if (width === 0) return
          const anchorLeft = root.getBoundingClientRect().left
          const margin = 8
          setShift(Math.max(
            margin - anchorLeft,
            Math.min(0, window.innerWidth - margin - width - anchorLeft),
          ))
        }
        fit()
        window.addEventListener('resize', fit)
        return () => {
          window.removeEventListener('resize', fit)
        }
      }, [menu])

      const open = React.useCallback((options) => {
        setMenu(null)
        disarm()
        setPhase('busy')
        Promise.resolve(openSideAssistant(parentSessionId, options)).then(
          () => {
            if (alive.current) setPhase('idle')
          },
          (error) => {
            console.warn('[side-assistant] open failed', error)
            if (alive.current) setPhase('error')
          },
        )
      }, [openSideAssistant, parentSessionId])

      // Delete one assistant from the menu, then re-read the list: the row is
      // gone, the remaining ones shift up a number, and an emptied menu closes
      // itself. A failed delete rejects, so the row can say so and retry.
      const onDelete = React.useCallback(async (childId) => {
        await deleteSideAssistant(childId)
        if (!alive.current) return
        let rows = []
        try {
          rows = await listSideAssistants(parentSessionId)
        } catch (error) {
          console.warn('[side-assistant] list failed', error)
          if (alive.current) setMenu(null)
          return
        }
        if (!alive.current) return
        if (rows.length === 0) {
          setMenu(null)
          return
        }
        setMenu(rows)
      }, [deleteSideAssistant, listSideAssistants, parentSessionId])

      // One press asks, the second one deletes; any other row cancels the ask.
      const pressDelete = React.useCallback((childId) => {
        if (deletingChild !== null) return
        if (armedChild !== childId) {
          disarm()
          setFailedChild(null)
          setArmedChild(childId)
          armTimer.current = setTimeout(() => {
            armTimer.current = null
            setArmedChild(null)
          }, DELETE_ARMED_MS)
          return
        }
        disarm()
        setDeletingChild(childId)
        Promise.resolve()
          .then(() => onDelete(childId))
          .catch((error) => {
            setDeletingChild(null)
            setFailedChild(childId)
            console.warn('[side-assistant] delete failed', error)
          })
      }, [armedChild, deletingChild, disarm, onDelete])

      const onClick = React.useCallback(() => {
        if (menu !== null) {
          setMenu(null)
          return
        }
        setPhase('busy')
        Promise.resolve(listSideAssistants(parentSessionId)).then(
          (rows) => {
            if (!alive.current) return
            setPhase('idle')
            if (rows.length === 0) {
              // No assistant yet: nothing to choose between, so the press is the
              // creation — exactly the one-press behaviour this replaced.
              open({})
              return
            }
            setMenu(rows)
          },
          (error) => {
            console.warn('[side-assistant] list failed', error)
            if (alive.current) setPhase('error')
          },
        )
      }, [listSideAssistants, menu, open, parentSessionId])

      const busy = phase === 'busy'
      const title = phase === 'error' ? t('failed') : t('open')

      return h('div', { className: 'side-assistant', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'side-assistant__action',
          'data-state': phase,
          onClick,
          disabled: busy || !parentSessionId,
          title,
          'aria-label': t('label'),
          'aria-haspopup': 'menu',
          'aria-expanded': menu !== null,
        },
        h('svg', {
          className: 'side-assistant__action-icon',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M2.5 3.2h11v7.4h-6L4.2 13.4V10.6h-1.7z' }),
        h('path', { d: 'M5.4 6.1h5.2M5.4 8h3.4' })),
        h('span', { className: 'side-assistant__action-label' }, busy ? t('busy') : t('label'))),
        menu === null ? null : h('ul', {
          ref: menuRef,
          className: 'side-assistant__menu',
          style: { left: shift },
          'aria-label': t('choose'),
        },
        menu.map((row, index) => h('li', { key: row.childId, className: 'side-assistant__menu-row' },
          h('button', {
            type: 'button',
            className: 'side-assistant__menu-item',
            onClick: () => open({ childId: row.childId }),
          }, `${t('assistant')} ${index + 1}`),
          h('button', {
            type: 'button',
            className: 'side-assistant__menu-delete',
            'data-confirming': armedChild === row.childId ? 'true' : 'false',
            'data-failed': failedChild === row.childId ? 'true' : 'false',
            disabled: deletingChild === row.childId,
            title: failedChild === row.childId ? t('deleteFailed') : t('delete'),
            onClick: (event) => {
              // The row itself opens the assistant; deleting must not do both.
              if (event !== undefined && event.stopPropagation !== undefined) event.stopPropagation()
              pressDelete(row.childId)
            },
          }, failedChild === row.childId
            ? t('deleteFailed')
            : armedChild === row.childId ? t('deleteConfirm') : t('delete')))),
        h('li', null,
          h('button', {
            type: 'button',
            className: 'side-assistant__menu-item side-assistant__menu-new',
            onClick: () => open({ create: true }),
          }, t('create')))))
    }

    /** Glyph for one tool row: running, done, failed. */
    function toolGlyph(status) {
      if (status === 'running') return '·'
      if (status === 'failed') return '!'
      return '✓'
    }

    /**
     * Fold one durable Session event into the strip's timeline.
     *
     * Three facts a watcher needs are kept, in the order they happened: turn
     * boundaries, tool calls with their outcome, and — from each settled
     * `assistant/message` — the chain of thought that step produced. The
     * assistant's own words are deliberately not repeated here: they are the
     * chat below.
     *
     * @param entries - current timeline, oldest first.
     * @param event - a `{ type, data }` Session event.
     * @returns the next timeline, bounded by `trimEntries`.
     */
    function foldEvent(entries, event) {
      if (event === undefined || event === null) return entries
      const data = event.data ?? {}
      if (event.type === 'tool/call') {
        return trimEntries(entries.concat({
          kind: 'tool',
          callId: typeof data.callId === 'string' ? data.callId : '',
          name: typeof data.name === 'string' && data.name !== '' ? data.name : 'tool',
          status: 'running',
        }))
      }
      if (event.type === 'tool/result') {
        const message = data.message ?? {}
        const callId = typeof message.callId === 'string' ? message.callId : (typeof data.callId === 'string' ? data.callId : '')
        if (callId === '') return entries
        const failed = message.isError === true || data.error !== undefined
        return entries.map((entry) => (
          entry.kind === 'tool' && entry.callId === callId && entry.status === 'running'
            ? { ...entry, status: failed ? 'failed' : 'done' }
            : entry
        ))
      }
      if (event.type === 'turn/end') {
        const turn = typeof data.turn === 'number' ? data.turn : undefined
        return settleAllThoughts(trimEntries(entries.concat({ kind: 'turn', turn })))
      }
      if (event.type === 'assistant/message') {
        const turn = typeof data.turn === 'number' ? data.turn : undefined
        const step = typeof data.step === 'number' ? data.step : undefined
        if (turn === undefined || step === undefined) return entries
        return settleStepThought(entries, turn, step, reasoningOf(data.stream))
      }
      return entries
    }

    /**
     * Expand the compact Assistant-stream records a Session payload carries.
     *
     * A stream is not one record per chunk: a reasoning run arrives as one
     * `reasoning-chunks` record holding several texts plus the gaps between
     * them, so both the live baseline and a settled `assistant/message` have to
     * be expanded before they are readable. The framework ships this expansion
     * privately, so it is mirrored here (and only the kinds the strip reads).
     *
     * @param records - compact records: `chunk`, `text-chunks`, `reasoning-chunks`, `tool-call-chunks`.
     * @returns the expanded chunks, oldest first.
     */
    function expandStream(records) {
      if (!Array.isArray(records)) return []
      const chunks = []
      for (const record of records) {
        if (record === null || typeof record !== 'object') continue
        if (record.type === 'chunk' && record.chunk !== null && typeof record.chunk === 'object') {
          chunks.push(record.chunk)
          continue
        }
        const members = record.type === 'tool-call-chunks' ? record.args : record.texts
        if (!Array.isArray(members)) continue
        for (const member of members) {
          if (typeof member !== 'string') continue
          if (record.type === 'text-chunks') chunks.push({ type: 'text-delta', text: member })
          else if (record.type === 'reasoning-chunks') chunks.push({ type: 'reasoning-delta', text: member })
          else chunks.push({ type: 'tool-call-delta', argumentsDelta: member })
        }
      }
      return chunks
    }

    /**
     * The chain of thought one compact stream holds.
     * @param stream - compact stream records, or anything else.
     * @returns the reasoning text, oldest first; '' when the step had none.
     */
    function reasoningOf(stream) {
      let text = ''
      for (const chunk of expandStream(stream)) {
        if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      return text
    }

    /**
     * Bound the timeline: rows by count, thought blocks by count, text by length.
     *
     * Thought blocks are trimmed on their own budget so a turn with many tools
     * cannot push the reasoning out of the strip, and a block that is still
     * streaming is never evicted while it is being written.
     *
     * @param entries - the timeline to bound.
     * @returns the same array when nothing had to go.
     */
    function trimEntries(entries) {
      const thoughts = entries.filter((entry) => entry.kind === 'thought')
      const dropped = new Set()
      if (thoughts.length > THOUGHT_BLOCKS) {
        const kept = new Set(thoughts.slice(thoughts.length - THOUGHT_BLOCKS))
        for (const entry of thoughts) if (kept.has(entry) === false && entry.status !== 'live') dropped.add(entry)
      }
      const rows = entries.filter((entry) => entry.kind !== 'thought')
      if (rows.length > PROGRESS_ROWS) {
        for (const entry of rows.slice(0, rows.length - PROGRESS_ROWS)) dropped.add(entry)
      }
      return dropped.size === 0 ? entries : entries.filter((entry) => dropped.has(entry) === false)
    }

    /** The identity a thought block is filed under: its attempt when the wire names one. */
    function thoughtKey(frame) {
      if (typeof frame.attemptId === 'string' && frame.attemptId !== '') return frame.attemptId
      if (typeof frame.turn === 'number' && typeof frame.step === 'number') return `${frame.turn}/${frame.step}`
      return 'live'
    }

    /**
     * Append reasoning to the block named `key`, opening the block when it is new.
     * @param entries - current timeline.
     * @param key - `thoughtKey` of the chunks being appended.
     * @param turn - the turn the chunks belong to, when known.
     * @param step - the step the chunks belong to, when known.
     * @param text - the reasoning delta just received.
     * @returns the next timeline.
     */
    function appendThought(entries, key, turn, step, text) {
      let found = false
      const next = entries.map((entry) => {
        if (entry.kind !== 'thought' || entry.key !== key) return entry
        found = true
        return { ...entry, text: (entry.text + text).slice(-THOUGHT_CHARS), status: 'live' }
      })
      if (found) return trimEntries(next)
      return trimEntries(next.concat({
        kind: 'thought',
        key,
        turn: typeof turn === 'number' ? turn : undefined,
        step: typeof step === 'number' ? step : undefined,
        text: text.slice(-THOUGHT_CHARS),
        status: 'live',
      }))
    }

    /**
     * Settle one step's thought from its durable record.
     *
     * The settled record carries the step's whole stream, which is authoritative
     * (it is what the main interface renders), so it replaces whatever the live
     * stream had accumulated for that step — and stands in for a step that
     * finished before the strip was watching.
     *
     * @param entries - current timeline.
     * @param turn - the settled step's turn.
     * @param step - the settled step's step.
     * @param text - reasoning recovered from the record; '' when it had none.
     * @returns the next timeline.
     */
    function settleStepThought(entries, turn, step, text) {
      let matched = false
      const next = entries.map((entry) => {
        if (matched || entry.kind !== 'thought') return entry
        if (entry.turn !== turn || entry.step !== step) return entry
        matched = true
        return {
          ...entry,
          text: (text === '' ? entry.text : text).slice(-THOUGHT_CHARS),
          status: 'done',
        }
      })
      if (matched || text === '') return matched ? trimEntries(next) : entries
      return trimEntries(next.concat({
        kind: 'thought',
        key: `step:${turn}/${step}`,
        turn,
        step,
        text: text.slice(-THOUGHT_CHARS),
        status: 'done',
      }))
    }

    /** Close every live thought: the turn they belonged to is over. */
    function settleAllThoughts(entries) {
      let changed = false
      const next = entries.map((entry) => {
        if (entry.kind !== 'thought' || entry.status !== 'live') return entry
        changed = true
        return { ...entry, status: 'done' }
      })
      return changed ? next : entries
    }

    /** Close the live thought of one attempt, when its `end` frame arrives. */
    function settleAttemptThoughts(entries, attemptId) {
      let changed = false
      const next = entries.map((entry) => {
        if (entry.kind !== 'thought' || entry.status !== 'live') return entry
        if (attemptId !== undefined && entry.key !== attemptId) return entry
        changed = true
        return { ...entry, status: 'done' }
      })
      return changed ? next : entries
    }

    /** One line of a thought, flattened and clipped, for the folded head. */
    function previewOf(text) {
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat === '') return null
      return flat.length <= 42 ? flat : `${flat.slice(0, 41)}…`
    }

    /** How long a delete press waits for its confirmation before forgetting. */
    const DELETE_ARMED_MS = 4000

    /**
     * The main Agent's progress strip.
     *
     * Follows the MAIN Session: `turn/*`, `tool/*` and `assistant/*` as durable
     * events, and — with `assistantStream: true` — the live stream of the
     * attempt in flight, whose `reasoning-delta` chunks are the main Agent's
     * chain of thought as it is written.
     *
     * The chain of thought is kept, not flashed: each step keeps its own block
     * once it has settled (`data-status="done"`), a step that was already
     * streaming when the pane opened is backfilled from the follow's
     * `assistantStream` baseline, and a step that settled before the pane opened
     * is recovered from its durable `assistant/message`. Only the newest blocks
     * survive (`THOUGHT_BLOCKS`), and each is clipped to `THOUGHT_CHARS`.
     *
     * Folded unless the user unfolded it: the strip repeats what the main view
     * already shows, so the folded state is a single line — a status dot, the
     * label, the newest thought as a preview, and a chevron — and the timeline
     * appears only on request. Following is independent of the fold.
     *
     * Receives `remote` (the Session remote) and `t` from the registration.
     */
    function ProgressPanel({ parentSessionId, remote, t }) {
      const [entries, setEntries] = React.useState([])
      const [phase, setPhase] = React.useState('idle')
      const [open, setOpen] = React.useState(progressOpen)
      const bodyRef = React.useRef(null)
      const stuckRef = React.useRef(true)
      const live = remote !== undefined && remote.session !== undefined && typeof parentSessionId === 'string'

      React.useEffect(() => {
        if (!live) return undefined
        const controller = new AbortController()
        let disposed = false
        const reading = { failed: false }

        const absorb = (event) => {
          if (disposed) return
          if (event !== undefined && event !== null && event.type === 'turn/start') setPhase('live')
          setEntries((current) => foldEvent(current, event))
          if (event !== undefined && event !== null && event.type === 'turn/end') setPhase('idle')
        }

        /** Backfill the attempt the follow opened on: it streamed before we listened. */
        const seedAttempt = (baseline) => {
          const attempt = baseline === undefined || baseline === null ? undefined : baseline.activeAttempt
          if (attempt === undefined || attempt === null) return
          const expanded = expandStream(attempt.stream)
          const published = typeof attempt.nextIndex === 'number' && attempt.nextIndex >= 0
            ? expanded.slice(0, attempt.nextIndex)
            : expanded
          let text = ''
          for (const chunk of published) {
            if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') text += chunk.text
          }
          if (text === '') return
          setEntries((current) => appendThought(current, thoughtKey(attempt), attempt.turn, attempt.step, text))
          setPhase('live')
        }

        const absorbFrame = (frame) => {
          if (disposed || frame === undefined || frame === null) return
          if (frame.type === 'start') {
            setPhase('live')
            return
          }
          if (frame.type === 'end') {
            setEntries((current) => settleAttemptThoughts(
              current,
              typeof frame.attemptId === 'string' ? frame.attemptId : undefined,
            ))
            return
          }
          const chunk = frame.chunk
          if (chunk === undefined || chunk === null) return
          if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            setPhase('live')
            setEntries((current) => appendThought(current, thoughtKey(frame), frame.turn, frame.step, chunk.text))
          }
        }

        const run = async () => {
          try {
            const stream = remote.session.follow({
              address: { kind: 'session', sessionId: parentSessionId },
              assistantStream: true,
            }, controller.signal)
            for await (const frame of stream) {
              if (disposed) break
              if (frame.type === 'snapshot') {
                const records = Array.isArray(frame.records) ? frame.records : []
                setEntries((current) => records.reduce((acc, record) => (
                  foldEvent(acc, record === null || typeof record !== 'object' ? undefined : record.event)
                ), current))
                seedAttempt(frame.assistantStream)
                continue
              }
              if (frame.type === 'event') {
                absorb(frame.event)
                continue
              }
              if (frame.type === 'assistant-stream') absorbFrame(frame.frame)
            }
          } catch (error) {
            if (disposed || controller.signal.aborted) return
            reading.failed = true
            setPhase('error')
            console.warn('[side-assistant] progress follow failed', error)
          }
        }

        reading.promise = run()
        return () => {
          disposed = true
          controller.abort()
        }
      }, [live, parentSessionId, remote])

      // The newest line is the interesting one — unless the user scrolled back.
      React.useEffect(() => {
        const body = bodyRef.current
        if (body === null || open !== true || stuckRef.current !== true) return
        body.scrollTop = body.scrollHeight
      }, [entries, open])

      const thoughts = entries.filter((entry) => entry.kind === 'thought')
      const newest = thoughts.length === 0 ? undefined : thoughts[thoughts.length - 1]
      const preview = open === true || newest === undefined ? null : previewOf(newest.text)
      const streaming = phase === 'live' || thoughts.some((entry) => entry.status === 'live')
      const dot = phase === 'error' ? 'error' : (streaming ? 'live' : 'idle')
      const head = t(dot === 'error' ? 'progressFailed' : 'progress')

      return h('div', { className: 'dsh-sa-progress', 'data-open': open ? 'true' : 'false' },
        h('div', { className: 'dsh-sa-progress__head' },
          h('button', {
            type: 'button',
            className: 'dsh-sa-progress__toggle',
            onClick: () => {
              progressOpen = !open
              stuckRef.current = true
              setOpen(progressOpen)
            },
            title: open ? t('progressFold') : t('progressOpen'),
            'aria-expanded': open,
          },
          h('span', { className: 'dsh-sa-progress__dot', 'data-state': dot }),
          h('svg', {
            className: 'dsh-sa-progress__chevron',
            viewBox: '0 0 16 16',
            width: 10,
            height: 10,
            'aria-hidden': true,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }, h('path', { d: 'M6 3.5L10.5 8L6 12.5' })),
          h('span', { className: 'dsh-sa-progress__label' }, head),
          preview === null ? null : h('span', { className: 'dsh-sa-progress__preview' }, preview))),
        open !== true ? null : h('div', {
          className: 'dsh-sa-progress__body',
          ref: bodyRef,
          onScroll: (event) => {
            const body = event === undefined || event === null ? undefined : event.currentTarget
            if (body === undefined || body === null) return
            stuckRef.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 8
          },
        },
          entries.length === 0 ? h('p', { className: 'dsh-sa-progress__empty' }, t('progressEmpty')) : null,
          entries.map((entry, index) => {
            if (entry.kind === 'thought') {
              return h('div', {
                key: `thought-${index}`,
                className: 'dsh-sa-progress__thinking',
                'data-status': entry.status,
              }, entry.text)
            }
            if (entry.kind === 'turn') {
              return h('div', { key: `turn-${index}`, className: 'dsh-sa-progress__row dsh-sa-progress__row--turn' },
                h('span', { className: 'dsh-sa-progress__glyph' }, '—'),
                h('span', { className: 'dsh-sa-progress__label' }, t('turnEnd')))
            }
            return h('div', { key: `tool-${index}`, className: 'dsh-sa-progress__row', 'data-status': entry.status },
              h('span', { className: 'dsh-sa-progress__glyph' }, toolGlyph(entry.status)),
              h('span', { className: 'dsh-sa-progress__label' }, entry.name))
          })))
    }

    /**
     * The embedded chat view: the conversation panel's own chat view, elected
     * through the `views` slot of the `conversation.content` factory.
     */
    function ChatView(props) {
      const renderSlot = props === undefined ? undefined : props.renderSlot
      return typeof renderSlot === 'function' ? renderSlot('conversation.session', { view: 'chat' }) : null
    }

    /**
     * Keeps a failure inside the chat area instead of blanking the whole pane.
     *
     * The Session scope area renders nothing when the retained reference is not
     * the binding this Controller serves, and React unmounts a subtree whose
     * render throws — which looks exactly like "the chat did not load".
     */
    class ChatBoundary extends React.Component {
      /** @param props - `{ message, children }`. */
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }

      /** @param error - the throw. @returns the state carrying it. */
      static getDerivedStateFromError(error) {
        return { error }
      }

      /** @returns the children, or the failure line. */
      render() {
        if (this.state.error === undefined) return this.props.children
        const detail = this.state.error === null || this.state.error === undefined
          ? String(this.state.error)
          : String(this.state.error.message === undefined ? this.state.error : this.state.error.message)
        return h('p', { className: 'side-assistant-pane__error' }, `${this.props.message}: ${detail}`)
      }
    }

    /**
     * The sidebar pane: progress strip above the shared chat.
     *
     * Receives the pane's standard props (`useResource`, `useTabInfo`,
     * `SessionProvider`, `renderFactorySlot`) plus this plugin's injected face.
     * The chat is the conversation panel's own embedded content — elected here
     * rather than read from the `sidebar.chat.conversation` seat, because that
     * seat decides its own phase from Session metadata (a detached Session has
     * none) and settles on an empty shell. Phase `active` is always right for
     * this pane: a side assistant either has history (the seed and the opener)
     * or is about to be typed into.
     */
    /**
     * Two shortcuts offered under the transcript: what is this project, what is
     * the agent doing now.
     *
     * Registered into the conversation's input dock, which renders directly above
     * the composer — inside the transcript's column, under the last answer. A
     * click sends the question as if the user had typed it (`conversation.send`,
     * the same call the composer makes), so the pane fills with a normal turn.
     *
     * The dock is a conversation-wide slot, so the entry renders in every
     * conversation view. It is hidden everywhere except inside this plugin's pane
     * by `SIDEBAR_CSS` (`.dsh-sa-cards` is `display: none` unless an ancestor is
     * `[data-sidebar-chat]`), which keeps the main conversation untouched without
     * asking the host which session a view belongs to.
     */
    function SuggestionDock({ send, t }) {
      const [busy, setBusy] = React.useState(undefined)
      const [error, setError] = React.useState(false)
      const ask = (id, text) => {
        if (busy !== undefined) return
        setBusy(id)
        setError(false)
        Promise.resolve()
          .then(() => send(text))
          .catch(() => {
            setError(true)
          })
          .finally(() => {
            setBusy(undefined)
          })
      }
      return h('div', {
        className: 'dsh-sa-cards',
        role: 'group',
        'data-state': error ? 'error' : undefined,
        'aria-label': t('label'),
      },
      h('button', {
        type: 'button',
        className: 'dsh-sa-card',
        disabled: typeof send !== 'function' || busy === 'project',
        onClick: () => ask('project', t('askProject')),
      }, t('askProject')),
      h('button', {
        type: 'button',
        className: 'dsh-sa-card',
        disabled: typeof send !== 'function' || busy === 'work',
        onClick: () => ask('work', t('askWork')),
      }, t('askWork')),
      error ? h('span', { className: 'dsh-sa-cards__error', role: 'status' }, t('askFailed')) : null)
    }

    function SideAssistantTab({ useResource, useTabInfo, SessionProvider, renderFactorySlot, remote, t }) {
      const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
      const tab = info === undefined ? undefined : info.tab
      const contentId = tab === undefined ? undefined : tab.contentId
      const resource = typeof useResource === 'function' ? useResource(contentId) : undefined
      const value = resource === undefined ? undefined : resource.value
      const address = value === undefined ? undefined : value.address
      const reference = value === undefined ? undefined : value.reference

      // The menu deletes by child id and cannot see this tab's id, so the pane
      // hands the pair over while it is on screen (see `openTabs`).
      const childId = address === undefined ? undefined : address.childSessionId
      const tabId = tab === undefined ? undefined : tab.id
      React.useEffect(() => {
        if (childId === undefined || tabId === undefined) return undefined
        openTabs.set(childId, tabId)
        return () => {
          if (openTabs.get(childId) === tabId) openTabs.delete(childId)
        }
      }, [childId, tabId])

      // `value === undefined` is the resource still opening. Anything else
      // missing here is a contract mismatch, and a blank pane would hide it.
      const chat = value === undefined
        ? null
        : reference === undefined || typeof SessionProvider !== 'function' || typeof renderFactorySlot !== 'function'
          ? h('p', { className: 'side-assistant-pane__error' }, t('chatFailed'))
          : h('div', { className: 'side-assistant-pane__chat' },
            h(ChatBoundary, { message: t('chatFailed') },
              h(SessionProvider, { session: reference },
                renderFactorySlot(
                  'conversation.content',
                  { variant: 'embedded', phase: 'active', hero: false },
                  { slots: { views: ChatView } },
                ))))

      return h('div', { className: 'side-assistant-pane', 'data-sidebar-chat': '' },
        address === undefined ? null : h(ProgressPanel, {
          parentSessionId: address.parentSessionId,
          remote,
          t,
        }),
        chat)
    }

    /** Host routes the Settings page talks to, both registered by `index.js`. */
    const SETTINGS_ENDPOINT = '/side-assistant/settings'
    const PING_ENDPOINT = '/side-assistant/ping'

    /** How long the "saved" confirmation stays on screen. */
    const SAVED_MS = 2500

    /** Ways the assistant can choose a model, and ways it can answer. */
    const MODEL_MODES = ['inherit', 'host', 'custom']
    const ANSWER_STYLES = ['brief', 'detailed']

    /**
     * Values the page starts from, mirroring the Host's shipped defaults.
     *
     * A failed or slow GET must not leave the page empty: the form shows these,
     * and a save from them writes a document the Host accepts as-is.
     */
    const SETTINGS_DEFAULTS = {
      label: '侧边助手',
      opener: 'hello',
      modelMode: 'inherit',
      provider: '',
      model: '',
      custom: { baseURL: '', model: '', apiKeyEnv: 'SIDE_ASSISTANT_API_KEY' },
      steps: 5,
      tokens: 2000,
      style: 'brief',
    }

    /** Field ranges the Host enforces; the page clamps to them before saving. */
    const SETTINGS_LIMITS = { steps: [1, 50], tokens: [500, 200000] }

    /**
     * Coerce one number field into a whole number inside its range.
     *
     * Empty and non-numeric input fall back to the shipped default rather than
     * sending a hole the Host would have to repair: an input cleared on the way
     * to a new value is a normal state for a text box.
     * @param value - the current form value.
     * @param range - `[smallest, largest]` accepted.
     * @param fallback - value used when `value` is not a number.
     * @returns the clamped whole number.
     */
    function wholeNumber(value, range, fallback) {
      if (value === '' || value === null || value === undefined) return fallback
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(range[1], Math.max(range[0], Math.round(number)))
    }

    /**
     * One complete settings document, field by field.
     *
     * The Host normalises too; doing it here as well is what lets the form bind
     * directly to the document (a missing style must not become an unchecked
     * radio group) and keeps a save from round-tripping values the page never
     * meant to change.
     * @param raw - what the Host returned, or anything at all.
     * @returns every field answered.
     */
    function normaliseSettings(raw) {
      const base = SETTINGS_DEFAULTS
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const custom = source.custom !== null && typeof source.custom === 'object' ? source.custom : {}
      return {
        label: typeof source.label === 'string' ? source.label : base.label,
        opener: typeof source.opener === 'string' ? source.opener : base.opener,
        modelMode: MODEL_MODES.includes(source.modelMode) ? source.modelMode : base.modelMode,
        provider: typeof source.provider === 'string' ? source.provider : base.provider,
        model: typeof source.model === 'string' ? source.model : base.model,
        custom: {
          baseURL: typeof custom.baseURL === 'string' ? custom.baseURL : base.custom.baseURL,
          model: typeof custom.model === 'string' ? custom.model : base.custom.model,
          apiKeyEnv: typeof custom.apiKeyEnv === 'string' && custom.apiKeyEnv !== ''
            ? custom.apiKeyEnv
            : base.custom.apiKeyEnv,
        },
        steps: wholeNumber(source.steps, SETTINGS_LIMITS.steps, base.steps),
        tokens: wholeNumber(source.tokens, SETTINGS_LIMITS.tokens, base.tokens),
        style: ANSWER_STYLES.includes(source.style) ? source.style : base.style,
      }
    }

    /**
     * GET one Host route and unwrap its `{ ok: … }` envelope.
     * @returns the parsed payload, with `ok === true`.
     * @throws when the transport fails or the envelope reports a failure.
     */
    async function read(path) {
      const response = await fetch(path, { method: 'GET' })

      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }

      if (payload === null || payload.ok !== true) {
        const detail = payload && (payload.message || payload.error)
        throw new Error(detail || `side-assistant: HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * The text a failure should put on screen.
     * @param failure - anything thrown.
     * @returns its message, or its string form.
     */
    function messageOf(failure) {
      return failure instanceof Error ? failure.message : String(failure)
    }

    /**
     * The side assistant's own page in Settings.
     *
     * Registered into `settings.section` — the left-hand list next to General,
     * Models and Plugins — not `plugins.item` (the plugin manager panel) and not
     * `settings.plugins.tab` (a tab buried inside the Plugins section). A
     * `settings.section` row is a list entry: it needs an `id`, an `order` and a
     * `label`, and the component owns its own heading. There is no
     * `configForms.whileServed` either: this plugin owns no settings namespace,
     * its document lives in its own storage file, so the page is registered
     * unconditionally.
     * The page reads the current settings once on mount, writes them back as one
     * flat object, and can ping the Host to prove the chosen model answers.
     *
     * The API key is write-only: the field starts empty and is never populated
     * from the Host, so the stored secret never travels back to the browser. A
     * blank field on save means "keep the stored key".
     */
    function SideAssistantSettings({ t, view }) {
      const copy = typeof t === 'function' ? t : (key) => key
      const [form, setForm] = React.useState(SETTINGS_DEFAULTS)
      const [limits, setLimits] = React.useState(SETTINGS_LIMITS)
      const [keyConfigured, setKeyConfigured] = React.useState(false)
      const [apiKey, setApiKey] = React.useState('')
      // `busy` is `null | 'saving' | 'testing'`: both buttons are disabled for
      // either write, so a save cannot race a probe against the same model.
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      const [probe, setProbe] = React.useState(null)
      const alive = React.useRef(true)
      const savedTimer = React.useRef(null)

      React.useEffect(() => {
        alive.current = true
        // The entry is also rendered as a one-liner in the plugin list; only
        // the opened page needs the stored document, so the row stays silent.
        if (view === 'summary') return undefined
        let cancelled = false
        read(SETTINGS_ENDPOINT)
          .then((payload) => {
            if (cancelled) return
            setForm(normaliseSettings(payload.settings))
            setKeyConfigured(payload.keyConfigured === true)
            if (payload.limits !== null && typeof payload.limits === 'object') {
              setLimits({
                steps: Array.isArray(payload.limits.steps) ? payload.limits.steps : SETTINGS_LIMITS.steps,
                tokens: Array.isArray(payload.limits.tokens) ? payload.limits.tokens : SETTINGS_LIMITS.tokens,
              })
            }
          })
          .catch((failure) => {
            if (!cancelled) setError(`${copy('settingsLoadFailed')}：${messageOf(failure)}`)
          })
        return () => {
          cancelled = true
          alive.current = false
          if (savedTimer.current !== null) {
            clearTimeout(savedTimer.current)
            savedTimer.current = null
          }
        }
      }, [])

      /** The document a save writes: the form, clamped and trimmed. */
      const formDocument = () => ({
        label: form.label,
        opener: form.opener,
        modelMode: form.modelMode,
        provider: form.provider,
        model: form.model,
        custom: {
          baseURL: form.custom.baseURL,
          model: form.custom.model,
          apiKeyEnv: form.custom.apiKeyEnv,
        },
        steps: wholeNumber(form.steps, limits.steps, SETTINGS_DEFAULTS.steps),
        tokens: wholeNumber(form.tokens, limits.tokens, SETTINGS_DEFAULTS.tokens),
        style: form.style,
      })

      const save = async () => {
        if (busy !== null) return
        setBusy('saving')
        setError(null)
        setSaved(false)

        const body = { settings: formDocument() }
        const key = apiKey.trim()
        if (key !== '') body.apiKey = key

        try {
          const payload = await post(SETTINGS_ENDPOINT, body)
          if (!alive.current) return
          setForm(normaliseSettings(payload.settings))
          setKeyConfigured(payload.keyConfigured === true)
          setApiKey('')
          setSaved(true)
          if (savedTimer.current !== null) clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(() => {
            savedTimer.current = null
            if (alive.current) setSaved(false)
          }, SAVED_MS)
        } catch (failure) {
          if (alive.current) setError(messageOf(failure))
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      const test = async () => {
        if (busy !== null) return
        setBusy('testing')
        setError(null)
        setProbe(null)

        try {
          const payload = await post(PING_ENDPOINT, {})
          if (!alive.current) return
          setProbe({
            ok: true,
            ms: payload.ms,
            provider: payload.provider,
            model: payload.model,
          })
        } catch (failure) {
          if (!alive.current) return
          setProbe({ ok: false, message: messageOf(failure) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      const pick = (key, value) => setForm((current) => ({ ...current, [key]: value }))
      const typed = (key) => (event) => pick(key, event.target.value)
      const numbered = (key) => (event) => pick(key, event.target.value === '' ? '' : Number(event.target.value))
      const typedCustom = (key) => (event) => setForm((current) => ({
        ...current,
        custom: { ...current.custom, [key]: event.target.value },
      }))

      const field = (label, control, hint) => h('div', { className: 'dsh-sa-settings-field' },
        h('span', { className: 'dsh-sa-settings-field-label' }, label),
        control,
        hint === undefined ? null : h('p', { className: 'dsh-sa-settings-hint' }, hint))

      const textInput = (name, value, onChange) => h('input', {
        className: 'dsh-sa-settings-input',
        type: 'text',
        name,
        value,
        onChange,
      })

      const choices = (name, current, options, onPick) => h('div', {
        className: 'dsh-sa-settings-options',
        role: 'radiogroup',
        'aria-label': name,
      }, options.map(([value, text]) => h('label', {
        key: value,
        className: 'dsh-sa-settings-option',
        'data-checked': current === value ? 'true' : 'false',
      },
      h('input', {
        className: 'dsh-sa-settings-radio',
        type: 'radio',
        name,
        value,
        checked: current === value,
        onChange: () => onPick(value),
      }),
      h('span', null, text))))

      const modelSection = h('section', { className: 'dsh-sa-settings-group' },
        h('h3', { className: 'dsh-sa-settings-group-title' }, copy('settingsModel')),
        choices('modelMode', form.modelMode, [
          ['inherit', copy('settingsModeInherit')],
          ['host', copy('settingsModeHost')],
          ['custom', copy('settingsModeCustom')],
        ], (value) => pick('modelMode', value)),
        form.modelMode === 'host'
          ? h('div', { className: 'dsh-sa-settings-inline' },
            field(copy('settingsProvider'), textInput('provider', form.provider, typed('provider'))),
            field(copy('settingsModelName'), textInput('model', form.model, typed('model'))))
          : null,
        form.modelMode === 'host'
          ? h('p', { className: 'dsh-sa-settings-hint' }, copy('settingsHostHint'))
          : null,
        form.modelMode === 'custom'
          ? h('div', { className: 'dsh-sa-settings-inline' },
            field(copy('settingsBaseURL'), textInput('baseURL', form.custom.baseURL, typedCustom('baseURL'))),
            field(copy('settingsCustomModel'), textInput('customModel', form.custom.model, typedCustom('model'))))
          : null,
        form.modelMode === 'custom'
          ? h('div', { className: 'dsh-sa-settings-row' },
            field(copy('settingsApiKey'), h('input', {
              className: 'dsh-sa-settings-input',
              type: 'password',
              name: 'apiKey',
              autoComplete: 'off',
              value: apiKey,
              placeholder: keyConfigured ? copy('settingsApiKeyKeep') : copy('settingsApiKeyPlaceholder'),
              onChange: (event) => setApiKey(event.target.value),
            })),
            keyConfigured ? h('span', { className: 'dsh-sa-settings-badge' }, copy('settingsApiKeyConfigured')) : null)
          : null,
        form.modelMode === 'custom'
          ? h('p', { className: 'dsh-sa-settings-hint' }, copy('settingsCustomHint'))
          : null)

      const contextSection = h('section', { className: 'dsh-sa-settings-group' },
        h('h3', { className: 'dsh-sa-settings-group-title' }, copy('settingsContext')),
        h('div', { className: 'dsh-sa-settings-inline' },
          field(copy('settingsSteps'), h('input', {
            className: 'dsh-sa-settings-input',
            type: 'number',
            name: 'steps',
            min: limits.steps[0],
            max: limits.steps[1],
            step: 1,
            value: form.steps,
            onChange: numbered('steps'),
          })),
          field(copy('settingsTokens'), h('input', {
            className: 'dsh-sa-settings-input',
            type: 'number',
            name: 'tokens',
            min: limits.tokens[0],
            max: limits.tokens[1],
            step: 1,
            value: form.tokens,
            onChange: numbered('tokens'),
          }))))

      const styleSection = h('section', { className: 'dsh-sa-settings-group' },
        h('h3', { className: 'dsh-sa-settings-group-title' }, copy('settingsStyle')),
        choices('style', form.style, [
          ['brief', copy('settingsStyleBrief')],
          ['detailed', copy('settingsStyleDetailed')],
        ], (value) => pick('style', value)))

      const identitySection = h('section', { className: 'dsh-sa-settings-group' },
        h('h3', { className: 'dsh-sa-settings-group-title' }, copy('settingsIdentity')),
        h('div', { className: 'dsh-sa-settings-inline' },
          field(copy('settingsLabel'), textInput('label', form.label, typed('label'))),
          field(copy('settingsOpener'), textInput('opener', form.opener, typed('opener')))))

      // The plugin list renders the same entry as a one-liner; returning the
      // description here keeps that row from expanding into the whole form.
      if (view === 'summary') return copy('description')

      return h('div', { className: 'dsh-sa-settings' },
        h('div', { className: 'dsh-sa-settings-header' },
          h('h2', { className: 'dsh-sa-settings-title' }, copy('title')),
          h('p', { className: 'dsh-sa-settings-intro' }, copy('settingsIntro'))),
        modelSection,
        contextSection,
        styleSection,
        identitySection,
        h('div', { className: 'dsh-sa-settings-footer' },
          h('button', {
            className: 'dsh-sa-settings-button dsh-sa-settings-save dsh-sa-settings-button--primary',
            type: 'button',
            disabled: busy !== null,
            onClick: save,
          }, busy === 'saving' ? copy('settingsSaving') : copy('settingsSave')),
          h('button', {
            className: 'dsh-sa-settings-button dsh-sa-settings-test',
            type: 'button',
            disabled: busy !== null,
            onClick: test,
          }, busy === 'testing' ? copy('settingsTesting') : copy('settingsTest')),
          saved ? h('span', { className: 'dsh-sa-settings-saved', role: 'status' }, copy('settingsSaved')) : null),
        error === null ? null : h('p', { className: 'dsh-sa-settings-error', role: 'alert' }, error),
        probe === null
          ? null
          : probe.ok === true
            ? h('p', { className: 'dsh-sa-settings-probe', role: 'status' },
              `${copy('settingsPingOk')} · ${probe.ms}ms · ${probe.provider}/${probe.model}`)
            : h('p', { className: 'dsh-sa-settings-error', role: 'alert' }, probe.message))
    }

    /**
     * Register the button, the tab type and the pane on the Client Context.
     * @param ctx - Client Context carrying the services this plugin injected.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(STYLE_ID, CSS), 'side-assistant: styles')
      ctx.effect(() => installStyles(SIDEBAR_ID, SIDEBAR_CSS), 'side-assistant: sidebar trim')
      ctx.effect(() => installStyles(SETTINGS_ID, SETTINGS_CSS), 'side-assistant: settings styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-assistant: dictionaries')

      const t = ctx.locale.bind(NS)

      // One side assistant per resource address. The address OBJECT is the
      // point: `sessions.retain` resolves it without asking the subagent
      // catalog, which is exactly what a detached Session has no entry in.
      ctx.inject(PANEL_SERVICES, (scope) => {
        scope.effect(() => scope.resources.register(chatResourceProvider(scope.sessions)), 'side-assistant: chat resource')

        scope.effect(() => scope.sidebarRightTabs.register({
          id: TAB_ID,
          kind: CHAT_KIND,
          patterns: [`${CHAT_ADDRESS}**`],
          priority: 'builtin',
          canOpen: (address) => parseChatAddress(address) !== undefined,
          title: () => t('label'),
        }), 'side-assistant: chat tab type')

        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: () => ({ remote: ctx.remote }),
          // Declared for the kit, not for the seat: a child whose scope is not
          // `root` is what makes the runtime hand this entry a SessionProvider.
          // The chat itself is elected from the `conversation.content` factory
          // in SideAssistantTab, so nothing has to fill this seat.
          children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
        }, SideAssistantTab)), 'side-assistant: chat tab body')
      })

      const actions = {
        /**
         * List this Session's side assistants, oldest first.
         * @param sessionId - the main Session that owns them.
         * @returns rows `{ childId, label, createdAt }`.
         */
        async listSideAssistants(sessionId) {
          const payload = await post(LIST_ENDPOINT, { sessionId })
          if (!Array.isArray(payload.assistants)) {
            throw new Error('side-assistant: list payload has no assistants')
          }
          return payload.assistants.filter((row) => row && typeof row.childId === 'string')
        },

        /**
         * Delete one side assistant.
         *
         * Deleting is archiving — the framework's own "remove it from every
         * list", which keeps the log on disk and leaves it restorable — and it
         * lives on the Workspace controller, not on the pane. If that assistant
         * is on screen its tab is closed too: a pane whose Session is gone
         * would sit there as an empty shell instead of saying "deleted".
         * @param childId - the assistant to delete.
         * @returns nothing; a failure rejects so the caller can show it.
         */
        async deleteSideAssistant(childId) {
          if (typeof childId !== 'string' || childId === '') {
            throw new Error('side-assistant: no assistant to delete')
          }
          const workspaces = ctx.get('workspaces')
          if (workspaces === undefined || typeof workspaces.archiveSession !== 'function') {
            throw new Error('side-assistant: this build cannot archive a Session')
          }
          await workspaces.archiveSession(childId, { stopActivity: true })
          const tabId = openTabs.get(childId)
          if (tabId === undefined) return
          openTabs.delete(childId)
          try {
            ctx.sidebarRight.close(tabId)
          } catch (error) {
            console.warn('[side-assistant] could not close the deleted tab', error)
          }
        },

        /**
         * Resolve a side assistant and show it in the right sidebar.
         * @param sessionId - the main Session to inherit.
         * @param options - `{ childId }` reopens one, `{ create: true }` makes a
         *   new one, `{}` takes the current one and creates it when absent.
         */
        async openSideAssistant(sessionId, options) {
          const body = { sessionId }
          if (options && typeof options.childId === 'string') body.childId = options.childId
          if (options && options.create === true) body.create = true

          const payload = await post(ENDPOINT, body)
          if (typeof payload.childId !== 'string') {
            throw new Error('side-assistant: ensure payload has no childId')
          }

          ctx.sidebarRight.openResource(chatAddress(payload.childId, sessionId))
        },
      }

      // The two shortcuts under the transcript. Registered on the conversation's
      // input dock — the strip that renders directly above the composer, under
      // the last answer — so a click sends the question exactly like typing it.
      // `SIDEBAR_CSS` keeps the entry visible inside this pane only.
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'side-assistant-cards',
        order: 30,
        locale: NS,
        inject: (sessionId) => {
          const scope = ctx.sessions.scope(sessionId)
          const conversation = scope === undefined ? undefined : scope.get('conversation')
          if (conversation === undefined || typeof conversation.send !== 'function') return {}
          return { send: (text) => conversation.send(text) }
        },
      }, SuggestionDock)), 'side-assistant: suggestion cards')

      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'side-assistant',
        order: -15,
        locale: NS,
        inject: () => actions,
      }, SideAssistantAction)), 'side-assistant: header action')

      // Settings → Plugins, as one tab next to the read-only inventory. Unlike
      // the shipped plugin pages this one has no settings namespace to wait for
      // (`ctx.configForms.whileServed`), because the Host keeps this document in
      // its own storage file rather than in the config schema — so the tab is
      // injected unconditionally and reads its values over the plugin's route.
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'side-assistant',
        order: 12,
        label: () => t('title'),
        locale: NS,
        inject: () => ({}),
      }, SideAssistantSettings)), 'side-assistant: settings section')
    }

    return { inject, apply }
  },
})
