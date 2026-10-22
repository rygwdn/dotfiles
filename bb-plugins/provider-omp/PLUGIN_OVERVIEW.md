Start a thread, pick OMP, and work in your repository from bb. The plugin runs your host's OMP CLI and streams its messages and tools into the bb timeline.

## What you get

- Models and per-model reasoning options from the host's OMP catalog, with environment overrides honoured. Model presets set every model role for one thread, with a settings editor for them.
- Checkpoint forks, eligible message edits, and idle-only manual compaction.
- Native OMP skills listed alongside bb skills.
- Host health, version status, installation guidance and provider account usage from `omp usage --json`.
- File-read, search, web-search, web-fetch and reasoning rows. File-read and search rows cannot retain result bodies in bb's SDK; `xd://` device calls are not shown as file changes.
- OMP extension status chips and text widgets above the composer, plus durable notifications and streaming cache-warming notices. Idle cache warming is silent unless it fails.
- Native To-do checklists, expandable subagent delegations with child transcripts, and background workflow cards for detached agents.
- `/omp-agent cancel <id>` and `/omp-agent steer <id> <message>` to control a running child without a model round trip, also available as Cancel and Steer buttons in the omp Hub.
- `/btw <question>` streams a side answer; `/btw cancel`, `/btw history` and `/btw follow <recordId> <question>` manage side questions.
- `/omp-bash <command>` runs a shell command through OMP and records its result; `/omp-bash abort` cancels user shell commands.
- `/omp-queue` lists OMP's native queue; `remove <n>`, `promote <n>` and `restore` manage it. Restore aborts the run and puts queued text back in the composer without resubmitting it; images are not restored.
- Pending background cards for side questions and user shell commands.
- A Slow mode session option when supported, with a warning when it affects every OMP session.

## Requirements

Install **OMP 18.10.0 or newer** on the host using the [official installation instructions](https://github.com/can1357/oh-my-pi#install). Upgrade with `omp update` (or your installation manager). Run `omp` on that host, then `/login` to authenticate before starting a bb thread.

The default executable is `omp` on `PATH`. For a different installation, set `BB_OMP_BRIDGE_COMMAND` and, if needed, `BB_OMP_BRIDGE_ARGS` (a JSON array of arguments) on the host.

## How it works

The bridge uses `omp --mode rpc`, waits for OMP's native `ready` event, and registers bb tools through `set_host_tools`. Prompt completion and session settlement use OMP's native RPC events, not an injected extension. Your own OMP extensions and plugins still load normally.

Each bb thread has its own session directory under `~/.bb/omp-bridge-sessions/`. Sessions containing only user shell commands can also be resumed.

bb's `full` permission mode sets OMP's `tools.approvalMode: yolo`; `accept-edits` sets it to `write`, allowing file edits while bash and other non-read tools prompt according to OMP's policy. Approval dialogs become native bb tool approvals. The bridge uses a private `--config` overlay, never edits your config file, and restarts the OMP process when permission mode changes. There is no `auto` mode.

**Accept-edits is not a workspace sandbox:** OMP's write tier is by tool, not path, so writes outside the workspace are not blocked.

Todo phases are flattened into bb's read-only checklist; empty updates are emitted only to clear an existing list. Each `task` child has a separate delegation; detached children keep updating after the spawning turn finishes. Delegation summaries do not repeat final replies already shown in the child transcript. The bridge subscribes to live child events and backfills messages incrementally, without counting child usage as parent usage.

OMP restarts cannot resume child execution/history discovery; bb retains rendered rows, but an abrupt whole-bridge crash still needs bb-core orphan cleanup.

## Limitations

OMP RPC has no plan-mode API (`--plan-yolo` is not equivalent). Manual compaction is idle-only because of bb's server limit. bb's native goal-clear action only understands Codex goal state; use `/goal drop`.

Changes to models or reasoning inside OMP appear in a status widget but do not move bb's pickers. bb has no native requests for queue edits, delegation controls, compaction instructions or todo edits; use the slash alternatives. Extension `setTitle` is ignored, and MCP passthrough is not applicable to this native RPC bridge.

See the [README](README.md) for command syntax and [omp RPC gaps](docs/omp-rpc-gaps.md) for protocol details.
