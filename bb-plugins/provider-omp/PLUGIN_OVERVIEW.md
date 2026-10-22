Start a thread, pick OMP, and work in your repository from bb. The plugin runs your host's OMP CLI and streams its messages and tools into the bb timeline.

## What you get

- Models and reasoning options from the host's OMP catalog, plus omp model presets that set every model role for one thread, with a settings editor for them.
- Checkpoint forks, eligible message edits, and manual compaction.
- Native OMP skills listed alongside bb skills.
- Host health and version status with installation guidance.
- OMP extension status chips and text widgets above the composer, plus durable notifications in the timeline.
- Native To-do checklists, expandable subagent delegations with child transcripts, and background workflow cards for detached agents.
- `/omp-agent cancel <id>` and `/omp-agent steer <id> <message>` to control a running child without a model round trip.

## Requirements

Install **OMP 18.10.0 or newer** on the host using the [official installation instructions](https://github.com/can1357/oh-my-pi#install). Upgrade with `omp update` (or your installation manager). Run `omp` on that host, then `/login` to authenticate before starting a bb thread.

The default executable is `omp` on `PATH`. For a different installation, set `BB_OMP_BRIDGE_COMMAND` and, if needed, `BB_OMP_BRIDGE_ARGS` (a JSON array of arguments) on the host.

## How it works

The bridge uses `omp --mode rpc`, waits for OMP's native `ready` event, and registers bb tools through `set_host_tools`. Prompt completion and session settlement use OMP's native RPC events, not an injected extension. Your own OMP extensions and plugins still load normally.

OMP runs with full permissions. Each bb thread has its own session directory under `~/.bb/omp-bridge-sessions/`.

Todo phases are flattened into bb's read-only checklist; empty updates are emitted only to clear an existing list. Each `task` child has a separate delegation; detached children keep updating after the spawning turn finishes. Delegation summaries do not repeat final replies already shown in the child transcript. The bridge subscribes to live child events and backfills messages incrementally, without counting child usage as parent usage.

OMP restarts cannot resume child execution/history discovery; bb retains rendered rows, but an abrupt whole-bridge crash still needs bb-core orphan cleanup.
