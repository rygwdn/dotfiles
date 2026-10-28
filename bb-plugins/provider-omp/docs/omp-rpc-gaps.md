# omp RPC gaps

What omp's RPC mode offers that this plugin doesn't use yet, or uses only in part.

Checked against omp 18.12.6 (`@oh-my-pi/pi-coding-agent`, `src/modes/rpc/rpc-types.ts`,
`rpc-mode.ts` and `wire/events.ts` / `wire/frames.ts`) and `@get-bb/plugin-sdk` 0.6.75.

## What already works

So the gaps below make sense, here's what the plugin covers today:

- **Launch:** live sessions run `omp --mode rpc-ui --cwd <thread cwd>`, so omp's `ask` tool is available.
  Forks and model catalog probes also pass `--cwd`; without it omp started from `$HOME` moves to `~/tmp`.
- **Transport:** `ready`, `negotiate_protocol` (v2), `rpc_chunk` reassembly, request/response ids,
  `set_event_filter` for delta-only message updates (`src/bridge/rpc-child.ts`, `rpc-session.ts`).
  Error responses keep omp's error code; unmatched error responses show as warnings.
  `rpc_frame_error` is fatal: it shuts down the transport rather than leaving requests pending.
- **Turns:** `prompt` (with `streamingBehavior: "followUp"`), `steer`, `abort`, `prompt_result`, `session_settled`.
  `abort` also cancels a pending auto-retry, so `abort_retry` isn't needed. Prompt errors keep the
  provider, model and HTTP status. `agent_start` / `agent_end` drive run lifecycle and
  todo/subagent reconciliation; `turn_end` refreshes context usage.
- **Streaming:** `message_start` / `message_update` / `message_end` with delta updates, text and thinking deltas, tool execution and tool stream events.
  Each assistant message closes at its own `message_end`. Bash results keep the real exit code.
  File reads, directory/search, web-search, web-fetch and reasoning use native typed rows.
  Single-file reads send the returned text (including errors) and explicit selector/range metadata;
  ambiguous multi-target reads remain generic. Searches (`grep`, `glob`, `find`, `ast_grep`, and
  directory `read`) send their original tool identity, query/path and full returned text/errors.
  Semantic-find scores, partial coverage and truncation/artifact notices remain verbatim.
  Descriptive `find` uses semantic-search labels and content mode, unlike filename
  `glob` discovery; scored hits, ranges and coverage remain exact output.
  Successful single-file `edit` results with validated path and complete snapshots
  or a matching unified patch additionally show a native diff in the generic row;
  original hashline arguments and result remain visible. Failures, ambiguous paths
  and `xd://` dispatches do not create a diff.
  Validated `xd://` device writes use the inner tool's identity, output and failure status;
  unsafe dispatches stay generic and never become file changes.
  Production bb SDK 0.6.79 retains native read/search identity but not their details: a successful
  `package.json:1-40` read and `test:supervisor` search rendered muted rows with no selector/range,
  returned text/matches, or expansion control; those values appeared only in the agent message body.
  Plugin-only rendering preserves those native rows. The SDK can customize the expanded body of generic
  `tool` items, but not typed `fileRead`, `search`, `webSearch`, `webFetch`, `fileChange`, `delegation`,
  or their headers. Replacing or augmenting the typed rows requires a new SDK/core timeline hook.
  Narration thinking blocks (omp 18.12+, Opus 5.5 prose between tool calls) render as answer text.
  With delta updates the flag only arrives at `message_end`, so Claude thinking stays open until then;
  a narration block that streamed as reasoning is closed blank so it leaves no Thought row.
- **Model and reasoning:** `get_available_models`, `set_model`, `set_thinking_level`, plus `--model` / `--thinking` at launch.
  Model-list requests honour `envVars`; reasoning effort choices are per-model, from catalog capabilities.
- **Fast mode:** omp's `/fast` command owns it; it passes through as a slash command. bb shows no Fast
  switch for omp models (the provider declares no service tiers) and ignores a `serviceTier` saved on older threads.
- **Slow mode:** a session option sends `set_slow_mode` when the model supports it. The label and
  description warn when `slowModeScope: "global"` means changing every omp session.
- **Model changed inside omp:** `model_changed`, `thinking_level_changed` and `config_update` refresh a
  thread status widget with omp's live model, thinking level and slow mode. bb's own
  pickers don't move (see "Blocked on bb"), but the plugin won't overwrite omp's choice with a stale picker value.
- **Reasoning level bb shows vs sends:** for a model without the thread's stored level (e.g. `medium` on a
  `low/high/max` model), bb's picker shows the nearest supported level (ties go up, so High) but still sends
  `medium`, which omp rounds down to `low`. The bridge runs the level bb shows instead (`bbDisplayedReasoningLevel`).
  Drop this once bb sends the level it displays.
- **Session controls:** omp's own config owns steering, follow-up and interrupt modes, auto-compaction,
  auto-retry and cache warming (`~/.omp/agent/config.yml`, or omp's `/settings`). bb shows no picker rows
  for them, never sends their setters, and ignores selections older threads saved for them.
- **Thread name:** bb rename sends `set_session_name`; omp's `session_info_update` title shows up in bb as the thread name.
- **Usage and cost:** full `get_session_stats` totals, including cost, counting every model call in a run.
  Provider maintenance usage is supported through `omp usage --json`, showing available account
  limits and reset windows separately from thread totals.
- **Compaction:** idle-only `compact`, `auto_compaction_start` / `auto_compaction_end` (see "Blocked on bb").
- **Retries and fallbacks:** `auto_retry_start` shows as a retrying provider error, `retry_fallback_applied` as a model fallback notice.
- **Notices:** omp session `notice` events, extension `notify`, `extension_error` and `command_output` reach bb.
  URLs in notices (including `open_url` from sign-in) render as links.
- **Cache warming:** streaming `cache_warming_start` / `cache_warming_end` open and close progress
  notices, including available billed usage. Idle warming is silent unless it errors.
- **Custom messages:** advisor notes, background job/process completion, late diagnostics, skill
  invocations and tangent dispatch render as structured Markdown cards, including when idle.
  Collab prompts retain the author; unknown displayed types keep text fallback and hidden types stay hidden.
- **Slash commands:** `available_commands_update` feeds bb's provider command list next to `/omp-agent`.
  bb can't complete arguments, so a command's subcommands are added to its hint when the hint doesn't
  already list them (`/todo` shows `<subcommand> (edit|copy|…)`). Output of omp-local commands
  (`/compact`, `/todo`, `/handoff`, …) shows in the thread.
  Commands now show before a thread's first turn: bb's `commands/list` is answered by the sessionless
  per-cwd catalog child (`get_available_commands`), with the same list a live session publishes.
- **MCP commands:** `/mcp` runs over RPC (`list`, `test`, `add`, `remove`, `enable|disable`, `resources`,
  `prompts`, `smithery-search`, `reload`). Since omp 18.12.6, `/mcp reauth <name>` works too: omp opens
  the browser on the machine it runs on, prints the authorization URL as command output and reconnects
  the server in the live session. bb's stop (`abort`) cancels a pending browser wait. `unauth`,
  `reconnect`, `notifications` and `smithery-login|logout` still reply that they need omp's TUI.
- **Plugin commands:** `/goal` (`goal` RPC); streaming `/btw <question>`, `/btw cancel|history`,
  `/btw follow <recordId> <question>` (`btw`, `btw_cancel`, `get_btw_history`, `btw_record`, `btw_delta`);
  `/omp-bash <command>` and `/omp-bash abort` (`bash`, `abort_bash`);
  `/omp-queue` and `remove <n>|promote <n>|restore` (`get_state.queuedMessages`,
  `remove_queued_message`, `promote_queued_message`, `abort_and_restore_queue`);
  `/login` and `/logout` (`get_login_providers`, `login`, `get_logout_accounts`, `logout`), `/export-html` (`export_html`).
  Side questions and user shell commands have pending background cards. Queue restore aborts the run
  and returns text to bb's composer without resubmitting it; images are not restored.
- **Goals:** `get_state.goal` and `goal_updated` show as a thread status widget; bb's goal composer action inserts `/goal`.
- **bb tools:** `set_host_tools`, `host_tool_call` / `cancel` / `update` / `result`.
- **Extension UI:** `select`, `confirm`, `input`, `editor`, `ask` (after `set_ask_dialog`), `cancel`, `notify`, `setStatus`, `setWidget`,
  `set_editor_text` (fills bb's composer once). Dialogs fit bb's limits: titles over 160 characters are
  cut and the full text moves into the body; generic dialogs stay under 64 KiB.
  Tool-approval `select` dialogs ("Allow tool: X", Approve / optional Approve X for this session / Deny)
  use native bb tool approvals instead, retaining the full approval reason.
- **Subagents:** `set_subagent_subscription: "events"`, lifecycle/progress/event frames, `get_subagents`, `get_subagent_messages`, `cancel_subagent`, `steer_subagent`. Stopping the thread cancels running subagents.
  The omp Hub's Cancel/Steer buttons send `/omp-agent` commands with steer-if-active delivery.
  omp rewrites a subagent transcript in place (temp file + rename) when an auto-retry recovers, and
  `get_subagent_messages` only resets the byte cursor when it is past the end of the file. The plugin
  re-reads from byte 0 when the file's identity changes and drops non-object entries; a failed read is a warning, not a turn failure.
- **Todos:** `get_state.todoPhases`. An empty todo list clears bb's plan.

## Permissions

bb offers `full` and `accept-edits`, not `auto`. A per-child `--config` overlay sets
`tools.approvalMode` to `yolo` for full access or `write` for accept-edits. In the latter mode,
file edits can proceed while bash and other non-read tools prompt according to omp's policy.
Changing permission mode rebuilds the child and preserves the conversation; the user's config file
is never modified. **Accept-edits does not enforce a workspace boundary:** omp's write tier is
based on tool identity, not the target path. omp's newer `always-ask-cached` mode (remembered file
and folder approvals) isn't offered: the overlay always picks `yolo` or `write`.

## Blocked on bb

omp supports these, but the bb provider bridge has nowhere to send them yet.

| Feature | omp has | Missing in bb |
| --- | --- | --- |
| Goal clear and native goal state | `goal { op: drop }`, `goal_updated { goal, state? }` | bb's `thread/goal/clear` expects `{ cleared }` and then waits for a goal-state change that bb only recognizes from the Codex provider (`agent-runtime` `runtime.ts` `clearThreadGoal`, `runtime-thread-goal-state.ts`). So `threadGoalClear` stays false; use `/goal drop`. Goal continuation also needs omp's `goal.continuationModes` to include `rpc` (default is `["interactive"]`). |
| Model changed inside omp | `model_changed` (no payload, read `get_state`), `thinking_level_changed { thinkingLevel?, configured?, resolved? }`, `config_update` after slash commands | A bridge event that updates bb's model / reasoning picker. The plugin shows the live values in a status widget meanwhile. |
| Mid-turn compaction | `compact` can abort, compact and resume a running turn | bb's server only accepts manual compaction while idle; the plugin also rejects active-turn compaction. |
| Queue editing | `remove_queued_message`, `promote_queued_message` (moves a follow-up to the end of steering), `get_state.queuedMessages`, `abort_and_restore_queue` | No native provider request to edit queued messages; use `/omp-queue` and its remove/promote/restore subcommands. This is omp's queue, not bb's pending queue. |
| Subagent controls | `cancel_subagent`, `steer_subagent` | No per-delegation control request; `/omp-agent` and the Hub buttons provide access today. |
| Compaction instructions | `compact { customInstructions }` | bb's manual compact request carries no instructions; use omp's `/compact` command instead. |
| Todo editing | `set_todos { phases }`, recorded on the session branch since omp 18.12.4 so it survives reload, resume and compaction | No plan edit surface; use omp's `/todo` commands. |
| Native timeline tool-row rendering | Generic `tool` items can use the plugin SDK's `experimental_timelineRenderer({ kind: "tool" })`; typed read/search/web/edit/delegation rows carry richer core identity | No provider hook to replace or augment those typed native rows, their headers, grouping, or lifecycle indicators. The plugin must preserve them; a future SDK hook would need provider-scoped typed-row body/header slots. |

## Smaller gaps

Lower value or niche. Listed so nothing is missed.

| omp RPC | What it does | Status |
| --- | --- | --- |
| `set_host_uri_schemes`, `host_uri_request` / `cancel` / `result` | Give omp's read/write tools host-backed `scheme://` URLs | Not used. Only worth it if there's bb data the agent should `read` by URL |
| `live_start`, `live_stop`, `live_mute`, `live_*` frames | Realtime voice session | Not used |
| `handoff` | Compact the current session into a handoff summary | Not used |
| `abort_and_prompt` | Abort and immediately send a new prompt | Not used. Queue restoration uses `abort_and_restore_queue` through `/omp-queue restore` |
| `get_available_thinking_levels` | Levels the current model supports | Not called separately; per-model efforts already come from catalog `thinking.efforts` |
| `cycle_model`, `cycle_thinking_level` | Step through models / levels | Not needed; bb sets them directly |
| `login` secret prompts | Sign-in flows that ask for a code or key before the URL | Not handled; the plugin falls back to "run `omp`, then `/login`" |
| `get_state.usageLimit` | Account usage stage (Claude only) | Not shown directly; provider usage comes from `omp usage --json` instead |
| `config_warnings_changed` | Config warnings changed | Dropped. It has no payload and warning text isn't exposed over RPC |
| `todo_auto_clear` | Todos auto-cleared | Ignored. omp declares it but never emits it |
| `advisor_cost_changed`, `advisor_yielded` | Advisor signals (no cost payload) | Dropped |
| `advisor` and displayed custom messages | Advisor notes and typed completion/context messages | Structured cards for advisor, async/process results, diagnostics, skills and tangent dispatch; collab prompts retain author |
| `irc_message` | Messages between omp agents | Sender/recipient/pool cards, deduplicated against later custom message boundaries |
| `ttsr_triggered` | A time-traveling stream rule (TTSR) matched the output | Rule-name/content cards; distinct triggers are preserved because omp supplies no occurrence ID |
| `todo_reminder` | Incomplete todos and reminder attempt | Checklist card without replacing canonical plan state; omp supplies no occurrence ID |
| `agent_start.resumedToolCallIds` | Tool calls from an earlier, unanswered assistant message that a continued run executes before calling the model | Ignored. The calls still arrive as normal `tool_execution_*` rows |
| `CompactionResult.providerReplayThroughEntryId` | Last entry a prefix-only remote compaction covers; later entries replay normally | Ignored. Internal replay bookkeeping with nothing to show |
| `setTitle` (extension UI) | Set terminal title | Ignored |
| `predict_word`, `predict_word_feedback` | Composer word prediction | Not used |

## Not used on purpose

| omp RPC | Why |
| --- | --- |
| `new_session`, `open_session`, `switch_session` | bb runs one omp process per thread and uses `--continue` / `--fork` instead |
| `branch` | bb forks into a new thread rather than moving the current one around omp's tree |
| `get_messages`, `get_messages_page`, `get_branch_messages`, `get_entries`, `get_last_assistant_text` | bb keeps its own transcript from the event stream |
| `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`, `set_auto_compaction`, `set_auto_retry`, `set_cache_warming`, `set_fast_mode` | Per-thread picker rows for these made bb's model picker long and only changed the running session. omp's config and `/fast` own them |

## Not possible through RPC

- **Plan mode:** omp RPC has no plan-mode API. `--plan-yolo` is not an equivalent planning mode.
- **Model roles** (`modelRoles`, e.g. separate models for plan, task, advisor): no RPC reads or sets
  them, and `/modelpreset switch <name>` can write global or project config. The plugin applies presets through a
  per-thread `--config` overlay at process start instead (README, "Model presets"), so it can't read the
  live role map back or change roles without restarting the omp process. The bb preset editor writes global config.
- **Restoring an interrupted session with its live subagents:** omp's `--restore` brings back an
  interrupted session, but only in the interactive TUI. It refuses `--mode` (`cli/args.ts`,
  `validateRestoreLaunch`), so an RPC child can't use it. Old subagents aren't lost, though: each
  subagent's transcript stays on disk at `<session>/<AgentId>.jsonl` and can be continued with
  `omp --mode rpc --fork <file>`. omp's in-memory registry (`get_subagents`) only lists subagents
  from the current process.
- **MCP passthrough:** not applicable to this native omp RPC bridge.
