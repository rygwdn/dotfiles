# OMP provider

bb provider `omp` runs a user-installed [OMP coding agent](https://omp.sh) on the
host. It requires **OMP 18.10.0 or newer**; the plugin does not bundle or install
an agent package.

## Setup

Install OMP on the host using the
[official installation instructions](https://github.com/can1357/oh-my-pi#install).
For macOS and Linux, the documented installer is:

```sh
curl -fsSL https://omp.sh/install | sh
```

Run `omp` on that host, then `/login` to authenticate. Select OMP when starting a
bb thread. Upgrade with `omp update`, or update through your installation manager.
The provider probes `omp --version` and reports missing or outdated installations;
it does not run an npm installation for you.

## Native RPC bridge

The bridge starts `omp --mode rpc` and waits for the native `ready` frame before
sending commands. bb tools are registered with `set_host_tools`; tool execution
uses `host_tool_call`, `host_tool_update`, `host_tool_result`, and
`host_tool_cancel` over the same RPC stream. There is no generated bb extension
or extra file-descriptor channel. User OMP extensions and plugins still load.

Prompt completion is correlated by command ID through `prompt_result`
(`agentInvoked`, `status`, `sessionSettled`, and optional `error`). A synchronous
prompt response with `agentInvoked: false` needs no later `prompt_result`.
`session_settled` reports when queued and background work has drained; an
`agent_end` alone does not mean the session is settled. The bridge exposes this
to bb as `omp/prompt/settled`.

OMP extension dialogs use native `extension_ui_request` and
`extension_ui_response` frames. Model and thinking changes use native RPC on the
live session.

Continuity uses the workspace `.omp/extensions/bb-continuity.ts` bootstrap and
the thread's contributed `BB_CONTINUITY_*` environment. Session children receive
those values unchanged; native `compact` RPC remains available. Sessionless
model catalog probes omit these variables and ignore them in their cache key,
so a model lookup cannot activate a thread's Continuity runtime.

Each thread stores its sessions in
`~/.bb/omp-bridge-sessions/<sanitized-providerThreadId>/`. Thread IDs use the
`omp_<UUID>` prefix. The bridge resumes with `--session-dir <dir> --continue`,
which opens the newest non-empty session in that thread's directory or creates a
fresh one there. Sessions containing only user-run shell commands also count as
non-empty. Forked threads have separate storage directories.

## Permissions

bb offers `full` and `accept-edits`; automatic approval review (`auto`) is not
supported. The bridge applies the selected mode through a temporary per-process
`--config` overlay, without changing your OMP config file:

- `full` sets `tools.approvalMode: yolo`.
- `accept-edits` sets `tools.approvalMode: write`: file edits can proceed without
  approval, while bash and other non-read tools prompt according to OMP's policy.

OMP's "Allow tool: X" approval dialogs become bb's native tool approvals, with
approve once, approve for this session when OMP offers it, and deny choices.
Changing permission mode restarts the OMP process and carries over the
conversation.

**`accept-edits` is not a workspace sandbox.** OMP's write tier is based on the
tool, not the target path, so it does not prevent writes outside the workspace.

## Tool rows and native controls

File reads, directory listings, searches, web searches, web fetches and reasoning
use bb's matching timeline rows. File-read and search rows do not retain result
bodies because bb's SDK has no result-body field for those row types. Writes to
`xd://` devices are tool dispatches, not file changes. Streaming cache warming
appears as a progress notice; idle cache warming is silent unless it fails.

These composer commands use OMP RPC directly, without a model round trip:

| Command | Action |
| --- | --- |
| `/btw <question>` | Stream a side answer without interrupting the main run. |
| `/btw cancel` | Cancel the running side question. |
| `/btw history` | List side questions and their record IDs. |
| `/btw follow <recordId> <question>` | Ask a follow-up on a previous side question. |
| `/omp-bash <command>` | Run a shell command and record its output and exit code in the OMP session. |
| `/omp-bash abort` | Request cancellation of all running OMP user shell commands. |
| `/omp-queue` | List OMP's native queued messages, not bb's pending queue. |
| `/omp-queue remove <n>` | Remove the numbered queued message. |
| `/omp-queue promote <n>` | Move a follow-up to the end of OMP's steering queue. |
| `/omp-queue restore` | Abort the run, remove OMP's queued messages and restore their text to bb's composer without resubmitting it. Images are not restored. |

Side questions and user shell commands show pending background cards while they
run. Shell command cards display text output only, even if OMP records images.

The session options include **Slow mode** when the active model supports it.
If OMP reports global scope, the option warns that changing it affects every OMP
session, not just this thread.

bb's provider usage view runs `omp usage --json` on the host to show available
account limits and reset windows. This is separate from the thread's token and
cost totals.

## Todos and subagents

OMP's canonical todo list is projected into bb's native plan/checklist. Multiple
phases are flattened with phase prefixes. In-progress tasks become active,
abandoned tasks appear failed, and blocked tasks remain pending with their
blocker in the label. The composer shows bb's read-only To-do card while a turn
is active. Successful `todo` calls retain their tool row as
well as publishing the checklist, matching bb's Claude provider. The bridge also
refreshes `get_state.todoPhases` after nested tool work and on turn boundaries,
and seeds it again on resume; incomplete-only reminders never replace the list.
An empty checklist snapshot is published only to clear a previously non-empty
list, never to add an empty plan row before todos exist.

Each child spawned by `task`, including batch calls, gets its own native
delegation with an expandable child transcript. Successful batch calls do not
also create a generic `task` row; rejected calls that spawn no children still
show their normal tool error. Labels and terminal summaries include OMP's
assignment/description, output or error, resolved model, and available usage.
When the final reply is already visible in the nested transcript, the terminal
delegation summary keeps only metadata and any error instead of repeating it.
The bridge subscribes to child events and reconciles completed messages/tools
with incremental `get_subagent_messages` reads, retaining terminal children
locally even after OMP removes them from `get_subagents`.

Detached children additionally share a native background-workflow card per
spawning call, showing each agent's state, model, last tool, and token usage.
Their cards and nested transcript updates can outlive the spawning turn; a
finished `task` call does not mark still-running children completed. OMP's
async-work yield completes the current bb turn; a later background-result
follow-up opens a new turn. Known open surfaces are interrupted when their
OMP process exits or is shut down.

bb has no targeted delegation/background-task control RPC, so the provider
advertises these composer commands (also usable through `bb thread tell`):

```text
/omp-agent cancel <subagent-id>
/omp-agent steer <subagent-id> <message>
```

Commands use OMP's native child cancellation/steering RPCs, not another model
prompt. A steer acknowledges acceptance, not child completion. They can target
only children still running in the attached OMP session.
When calling these from an agent shell, unset `BB_THREAD_ID` so bb sends the
literal command instead of wrapping it as an agent-to-agent message.

Limitations: an OMP restart cannot resume child execution/history discovery, and
an abrupt whole-bridge crash needs bb-core orphan cleanup; prior rendered rows
remain in bb's log, while backfill covers children known to the live process.

## omp Hub panel

omp threads get an **omp Hub** tab in the thread's right panel.

**Agents** lists the thread's subagents, live and finished, as a tree:
status, model (role), cost, tokens, tool calls, duration, the current tool or
intent, and any error or retry. Select an agent to read its conversation
in the panel. The conversation comes from bb's saved nested transcript, so it
is still there after the omp process restarts. Each delegation card's summary
has a **Details** button that opens the Hub on that agent.

Running agents also have **Cancel** and **Steer** controls in the tree and
conversation view. They send the `/omp-agent` commands above, steering into the
active turn when one is running.

The bridge publishes the roster as `provider-omp/agents` extension state. It
keeps the newest 64 agents and stays under 48 KiB, dropping the oldest agents
first. Progress-only changes are sent at most once every 2 seconds.

**Services** lists omp's daemon-supervised processes for the thread's
directory (`omp ps`), such as dev servers that omp's bash tool started with a
`name`. Each row shows the state, pid, uptime and URL. The URL comes from the
service's `ready` port, or else from the first URL in its ready log line. You
can open the URL, read logs, restart, stop, or kill. omp's own helpers
(`omp.*`) are hidden unless you turn on "Show omp internals". The panel polls
every 5 seconds while it is open. The plugin's host entry runs `omp ps` on the
thread's host. When that host isn't the bb server's machine, the URL points to
that host's loopback, and the panel says so.

The SDK has no way to change an open panel's saved params. So after the first
open, picking a different agent only lasts for the current session.

## Extension UI

OMP extensions' `setStatus` entries and string-array `setWidget` content appear in
a thread-scoped banner above bb's composer. Updates replace entries by key;
omitting the text or lines clears that key. Empty strings and empty line arrays
remain valid entries. ANSI terminal formatting is removed.

The latest snapshot is persisted as `provider-omp/status`. It retains insertion
order, with up to 24 statuses and 8 widgets, keys up to 128 characters, status
text up to 512 characters, and up to 16 lines of 512 characters per widget. The
serialized snapshot is capped at 24 KiB and the banner marks truncated content.
State is cleared when an OMP child exits or is replaced, including startup
respawns; extensions can re-emit their state on session start.

Notifications become durable timeline rows with their severity and full message.
During a turn, these are `provider-omp/notice` extension items with expandable
message bodies. bb cannot attach extension items outside an active turn, so
startup/idle notifications use its native warning-operation surface, labeled
with the original info, warning, or error severity. Oversized extension-item
payloads use the same full-message fallback. Error notifications do not fail the
thread.

bb's banner surface is above the composer only: widgets requested below the OMP
editor are grouped after above-editor widgets in that banner, not physically
below bb's editor. Component-factory widgets are not serialized by OMP RPC and
cannot be displayed. `setTitle` remains ignored. Status, widget, notification,
and title frames are fire-and-forget and never receive an extension UI answer.

## Limitations

- No plan mode: OMP RPC has no plan-mode API, and `--plan-yolo` is not equivalent.
- Manual compaction is idle-only because bb's server does not accept it during
  an active turn.
- Native goal clearing is unavailable because bb only recognizes Codex's goal
  state. Use `/goal drop`.
- Model or reasoning changes made inside OMP appear in a status widget, but do
  not move bb's pickers; bb has no bridge event for that update.
- bb has no native requests for queue editing, delegation controls, compaction
  instructions or todo editing. Use the slash commands instead (`/omp-queue`,
  `/omp-agent`, OMP's `/compact` and `/todo`).
- Extension `setTitle` is ignored. MCP passthrough is not applicable to this
  native RPC bridge.

See [omp RPC gaps](docs/omp-rpc-gaps.md) for the detailed protocol inventory.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BB_OMP_BRIDGE_COMMAND` | Executable override; defaults to `omp` on `PATH`. |
| `BB_OMP_BRIDGE_ARGS` | JSON array of launch arguments for the executable override. |
| `BB_OMP_BRIDGE_SESSION_DIR` | Session storage root; defaults to `~/.bb/omp-bridge-sessions`. |
| `BB_OMP_BRIDGE_READINESS_TIMEOUT_MS` | RPC readiness timeout in milliseconds; defaults to `60000`. |
| `BB_OMP_CATALOG_IDLE_MS` | Catalog helper idle lifetime in milliseconds; defaults to `60000`. |

Set launch overrides on the host running OMP. The version probe uses the same
executable override as the bridge.

OMP's own configuration retains upstream environment names: `PI_CODING_AGENT_DIR`
changes its default `~/.omp/agent` state directory (relative paths use the launch
directory; `~` is not expanded), and `PI_CONFIG_DIR` changes the configuration
directory name (default `.omp`). `OMP_PROFILE` (or the fallback `PI_PROFILE`)
selects a named profile, by default under `~/.omp/profiles/<name>/agent`, taking
precedence over `PI_CODING_AGENT_DIR`. These are not `OMP_CODING_AGENT_DIR` or bb
session-storage settings.

## Model list

The plugin settings (Settings → Plugins → omp) decide which omp models show in
bb's model picker. Hidden models go under **More models**: they stay searchable
and selectable, so no thread loses its model. By default only the latest model
of each family shows (newest Opus, newest GPT mini, and so on); models omp has
no family for always show. The other filters are off until you set them:
minimum intelligence score, maximum input and output price, minimum context
window, reasoning, image input and tool support, provider allow and deny lists,
and an always-show list. Lists are comma-separated names or `*` globs.

Missing data never hides a model (no score, unknown price, unknown context or
tool support). omp's current model and its `modelRoles` models always show, and
if the filters would hide everything the full list shows instead. Each model's
description carries its price per million tokens, context window and score.

A change applies to the picker within a couple of seconds; running threads are
not interrupted.

Model-list requests honour their environment overrides (`envVars`), including
OMP profile/config selection. Reasoning effort choices come from each model's
catalog capabilities rather than a fixed ladder.

## Model presets

omp's `modelPresets` (in `~/.omp/agent/config.yml`, a project `.omp/config.yml`,
or a `PI_CONFIG_FILES` overlay) show in the model picker as `preset:<name>`
entries. A preset sets every omp model role at once (default, smol, slow, plan,
task, advisor, commit, ...) plus an optional default thinking level. The
**Model presets in the picker** setting picks presets and models (default),
presets only (all models go under **More models**), or no presets.

Picking a preset applies it to that thread only. The bridge writes the preset's
roles into a temporary `--config` overlay for the thread's omp process, with
`null` for roles the preset leaves out, so they don't fall back to your global
roles. Your config files and other threads are untouched; omp's own
`/modelpreset switch` is never used because it can write global or project config.

- Switching to a different preset restarts the thread's omp process with the new
  overlay. The conversation carries over.
- Picking a plain model after a preset only changes the active model; the
  preset's other roles stay. The thread remembers its preset across restarts
  (`bb-model-preset.json` in its session directory).
- The preset's main model is the first of its `default` role's choices that the
  catalog knows, following `@role` aliases inside the preset.
- `omp commit` runs as its own process and reads only your config files, so the
  `commit` role doesn't follow a thread's preset. Agents that name an explicit
  model ignore roles.

Edit presets under Settings → Plugins → omp → **omp model presets**. The editor
changes the global config on the primary host: one model and thinking suffix
per role, and values it can't match to a model (aliases, patterns) are kept
as they are. Saves keep comments and other keys, write through symlinks, and
refuse to overwrite a file that changed since it was loaded. The picker
refreshes within a couple of seconds; presets edited outside bb show after
bb's next catalog refresh.

## Native skills

bb resolves skill roots on the host using its active OMP profile and settings.
With the default configuration, the roots are:

- User: `~/.omp/agent/skills`, `~/.omp/agent/managed-skills`,
  `~/.agent/skills`, `~/.agents/skills`.
- Project, including ancestors: `.omp/skills`, `.agent/skills`, `.agents/skills`,
  `.claude/skills`.
- Current project directory only: `.codex/skills`, `.opencode/skills`,
  `.github/skills`.

Ancestor discovery stops at the repository root (or home when there is no
repository root), excluding home itself. Relocated agent directories, enabled
opt-in user sources, and directory-source enable/disable settings are resolved
on the host rather than declared as fixed default paths.

Custom directories come from `skills.customDirectories` in OMP's YAML
configuration. Paths support `~/`; relative paths use the session's working
directory. Entries are literal directories, not package sources or standalone
Markdown files. bb scans directory roots' immediate `<name>/SKILL.md` children,
without recursive descent.
The resolver reads user `config.yml` or `config.yaml` (falling back to
`settings.json` only when both are absent), project `.omp/settings.json` and
`.omp/config.yml`, and `PI_CONFIG_FILES` overlays.

OMP-native Skillshare installs are resolved from ancestor `.omp/skills.lock.json`
files and the user agent directory's `skills.lock.json`. Only installed skills
with matching integrity markers and `SKILL.md` files are exposed, directly as
individual `SKILL.md` file roots. The `skillshare` provider can be disabled
independently of the native directory sources.

Settings imported from other agents' configuration files, plugin- and
extension-supplied skills, and per-skill include/ignore filters are outside bb's
directory-root metadata. OMP's own loader remains authoritative for which skills
the agent actually loads.

## Memory

Every omp process this bridge launches — thread sessions and forked sessions
alike — runs with a `--config` overlay containing `memory: { backend: off }`,
so OMP's native Mnemopi memory writes nothing for BB-hosted threads. Durable
memory for BB-hosted agents is owned by the `memory-fork` plugin instead
(scopes: global/project/bot; see its own documentation). Standalone omp runs on
this machine are unaffected: they keep whatever memory backend your own OMP
configuration selects. Because the native memory backend is off, OMP's
`memory_edit` tool is unavailable in BB-hosted sessions; corrections go through
the memory-fork CLI (`bb memory update` / `bb memory forget`) per its memory skill.
