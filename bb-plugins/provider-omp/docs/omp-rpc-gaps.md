# omp RPC gaps

What omp's RPC mode offers that this plugin doesn't use yet, or uses only in part.

Checked against omp 18.10.4 (`@oh-my-pi/pi-coding-agent`, `src/modes/rpc/rpc-types.ts`,
`rpc-mode.ts` and `wire/events.ts` / `wire/frames.ts`) and `@get-bb/plugin-sdk` 0.6.49.

## What already works

So the gaps below make sense, here's what the plugin covers today:

- **Launch:** live sessions run `omp --mode rpc-ui --cwd <thread cwd>`, so omp's `ask` tool is available.
  Forks and model catalog probes also pass `--cwd`; without it omp started from `$HOME` moves to `~/tmp`.
- **Transport:** `ready`, `negotiate_protocol` (v2), `rpc_chunk` reassembly, request/response ids,
  `set_event_filter` for delta-only message updates (`src/bridge/rpc-child.ts`, `rpc-session.ts`).
  Error responses keep omp's error code; error responses with no id and `rpc_frame_error` show as warnings.
- **Turns:** `prompt` (with `streamingBehavior: "followUp"`), `steer`, `abort`, `prompt_result`, `session_settled`.
  `abort` also cancels a pending auto-retry, so `abort_retry` isn't needed. Prompt errors keep the
  provider, model and HTTP status.
- **Streaming:** `message_start` / `message_update` / `message_end` with delta updates, text and thinking deltas, tool execution and tool stream events.
  Each assistant message closes at its own `message_end`. Bash results keep the real exit code.
- **Model and reasoning:** `get_available_models`, `set_model`, `set_thinking_level`, plus `--model` / `--thinking` at launch.
  The model catalog is built with the thread's env overrides.
- **Fast mode:** bb's service tier picker offers default / fast and sends `set_fast_mode` when it changes.
  Enabled isn't the same as active: omp only speeds up models that support it (`fastModeActive`).
- **Model changed inside omp:** `model_changed`, `thinking_level_changed` and `config_update` refresh a
  thread status widget with omp's live model, thinking level, fast mode and session controls. bb's own
  pickers don't move (see "Blocked on bb"), but the plugin won't overwrite omp's choice with a stale picker value.
- **Session controls:** steering, follow-up and interrupt modes, auto-compaction, auto-retry and cache
  warming are bb session options (`set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`,
  `set_auto_compaction`, `set_auto_retry`, `set_cache_warming`). "Native" leaves omp's config alone.
- **Thread name:** bb rename sends `set_session_name`; omp's `session_info_update` title shows up in bb as the thread name.
- **Usage and cost:** full `get_session_stats` totals, including cost, counting every model call in a run.
- **Compaction:** `compact`, `auto_compaction_start` / `auto_compaction_end`.
- **Retries and fallbacks:** `auto_retry_start` shows as a retrying provider error, `retry_fallback_applied` as a model fallback notice.
- **Notices:** omp session `notice` events, extension `notify`, `extension_error` and `command_output` reach bb.
  URLs in notices (including `open_url` from sign-in) render as links.
- **Custom messages:** advisor notes, background job/process completion, late diagnostics, skill
  invocations and tangent dispatch render as structured Markdown cards, including when idle.
  Collab prompts retain the author; unknown displayed types keep text fallback and hidden types stay hidden.
- **Slash commands:** `available_commands_update` feeds bb's provider command list next to `/omp-agent`.
  bb can't complete arguments, so a command's subcommands are added to its hint when the hint doesn't
  already list them (`/todo` shows `<subcommand> (edit|copy|…)`). Output of omp-local commands
  (`/compact`, `/todo`, `/handoff`, …) shows in the thread.
- **Plugin commands:** `/goal` (`goal` RPC), `/btw` (`btw`, answered beside the main conversation),
  `/login` and `/logout` (`get_login_providers`, `login`, `get_logout_accounts`, `logout`), `/export-html` (`export_html`).
- **Goals:** `get_state.goal` and `goal_updated` show as a thread status widget; bb's goal composer action inserts `/goal`.
- **bb tools:** `set_host_tools`, `host_tool_call` / `cancel` / `update` / `result`.
- **Extension UI:** `select`, `confirm`, `input`, `editor`, `ask` (after `set_ask_dialog`), `cancel`, `notify`, `setStatus`, `setWidget`,
  `set_editor_text` (fills bb's composer once). Dialogs fit bb's limits: titles over 160 characters are
  cut and the full text moves into the body; the whole dialog stays under 64 KiB.
- **Subagents:** `set_subagent_subscription: "events"`, lifecycle/progress/event frames, `get_subagents`, `get_subagent_messages`, `cancel_subagent`, `steer_subagent`. Stopping the thread cancels running subagents.
- **Todos:** `get_state.todoPhases`. An empty todo list clears bb's plan.

## Worth doing in the plugin

### 1. Tool approvals

- **omp has:** when a tool needs approval and the host has no approval dialog, omp asks with an
  Approve/Deny `select` (`tools/approval.ts`, `requestApproval`). The plugin already answers `select`.
- **Plugin today:** only offers the `full` permission mode.
- **Next:** turn omp approvals on, check the Approve/Deny prompt reads well in bb, then decide which
  bb permission modes map onto omp's approval settings.

### 2. Compacting during a turn

- **omp has:** `compact` works mid-turn. omp aborts the turn, compacts, and normally resumes it.
- **Plugin today:** refuses to compact while a turn is running (`src/bridge/rpc-session.ts`, `compact()`).
- **Next:** check how bb tracks a turn that omp aborts and resumes around a compaction before dropping the refusal.

### 3. Slow mode

- **omp has:** `set_slow_mode { enabled }`, `slowModeSupported`, `slowModeScope`.
- **Not offered:** with `slowModeScope: "global"`, omp writes `providers.anthropic.slowMode` to its
  global config, so turning it on in one bb thread changes every omp session. Only add it if bb can
  say so in the picker.

## Blocked on bb

omp supports these, but the bb provider bridge has nowhere to send them yet.

| Feature | omp has | Missing in bb |
| --- | --- | --- |
| Goal clear and native goal state | `goal { op: drop }`, `goal_updated { goal, state? }` | bb's `thread/goal/clear` expects `{ cleared }` and then waits for a goal-state change that bb only recognizes from the Codex provider (`agent-runtime` `runtime.ts` `clearThreadGoal`, `runtime-thread-goal-state.ts`). So `threadGoalClear` stays false; use `/goal drop`. Goal continuation also needs omp's `goal.continuationModes` to include `rpc` (default is `["interactive"]`). |
| Model changed inside omp | `model_changed` (no payload, read `get_state`), `thinking_level_changed { thinkingLevel?, configured?, resolved? }`, `config_update` after slash commands | A bridge event that updates bb's model / reasoning picker. The plugin shows the live values in a status widget meanwhile. |
| Queue editing | `remove_queued_message`, `promote_queued_message` (moves a follow-up to the end of steering), `get_state.queuedMessages` | A provider request to edit, remove or reorder queued messages. |
| Subagent controls | `cancel_subagent`, `steer_subagent` (reachable today via `/omp-agent`) | A per-delegation control request. |
| Compaction instructions | `compact { customInstructions }` | bb's manual compact request carries no instructions. |
| Todo editing | `set_todos { phases }` | A plan edit surface. |

## Smaller gaps

Lower value or niche. Listed so nothing is missed.

| omp RPC | What it does | Status |
| --- | --- | --- |
| `set_host_uri_schemes`, `host_uri_request` / `cancel` / `result` | Give omp's read/write tools host-backed `scheme://` URLs | Not used. Only worth it if there's bb data the agent should `read` by URL |
| `btw_cancel`, `get_btw_history`, `btw_record` | Cancel or list side questions | Not used; `/btw` covers asking |
| `live_start`, `live_stop`, `live_mute`, `live_*` frames | Realtime voice session | Not used |
| `bash`, `abort_bash` | User-run shell command recorded in the session | Not used |
| `handoff` | Compact the current session into a handoff summary | Not used |
| `abort_and_prompt`, `abort_and_restore_queue` | Abort and send, or abort and hand queued input back to the host | Not used. A plain `abort` keeps omp's queued follow-ups; `abort_and_restore_queue` removes them from omp and would need the plugin to re-queue them |
| `get_available_thinking_levels` | Levels the current model supports | Not used; bb's reasoning ladder is static |
| `cycle_model`, `cycle_thinking_level` | Step through models / levels | Not needed; bb sets them directly |
| `login` secret prompts | Sign-in flows that ask for a code or key before the URL | Not handled; the plugin falls back to "run `omp`, then `/login`" |
| `get_state.usageLimit` | Account usage stage (Claude only) | Not shown; `maintenance.usage` is false |
| `config_warnings_changed` | Config warnings changed | Dropped. It has no payload and warning text isn't exposed over RPC |
| `todo_auto_clear` | Todos auto-cleared | Ignored. omp declares it but never emits it |
| `advisor_cost_changed`, `advisor_yielded` | Advisor signals (no cost payload) | Dropped |
| `advisor` and displayed custom messages | Advisor notes and typed completion/context messages | Structured cards for advisor, async/process results, diagnostics, skills and tangent dispatch; collab prompts retain author |
| `irc_message` | Messages between omp agents | Sender/recipient/pool cards, deduplicated against later custom message boundaries |
| `ttsr_triggered` | A time-traveling stream rule (TTSR) matched the output | Rule-name/content cards; distinct triggers are preserved because omp supplies no occurrence ID |
| `todo_reminder` | Incomplete todos and reminder attempt | Checklist card without replacing canonical plan state; omp supplies no occurrence ID |
| `cache_warming_start`, `cache_warming_end` | Cache warming progress | Dropped |
| `setTitle` (extension UI) | Set terminal title | Ignored |
| `predict_word`, `predict_word_feedback` | Composer word prediction | Not used |

## Not used on purpose

| omp RPC | Why |
| --- | --- |
| `new_session`, `open_session`, `switch_session` | bb runs one omp process per thread and uses `--continue` / `--fork` instead |
| `branch` | bb forks into a new thread rather than moving the current one around omp's tree |
| `get_messages`, `get_messages_page`, `get_branch_messages`, `get_entries`, `get_last_assistant_text` | bb keeps its own transcript from the event stream |
| `agent_start`, `agent_end`, `turn_start`, `turn_end` | `prompt_result` and `session_settled` already mark turn boundaries |

## Not possible through RPC

- **Model roles** (`modelRoles`, e.g. separate models for plan, task, advisor): no RPC reads or sets
  them, and `/modelpreset switch <name>` writes to global config. The plugin applies presets through a
  per-thread `--config` overlay at process start instead (README, "Model presets"), so it can't read the
  live role map back or change roles without restarting the omp process.
- **Restoring an interrupted session with its live subagents:** omp's `--restore` brings back an
  interrupted session, but only in the interactive TUI. It refuses `--mode` (`cli/args.ts`,
  `validateRestoreLaunch`), so an RPC child can't use it. Old subagents aren't lost, though: each
  subagent's transcript stays on disk at `<session>/<AgentId>.jsonl` and can be continued with
  `omp --mode rpc --fork <file>`. omp's in-memory registry (`get_subagents`) only lists subagents
  from the current process.
