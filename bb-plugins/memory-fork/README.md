# bb-plugin-memory-fork

Fork of BB's official Memory plugin (upstream: `get-bb/bb` `plugins/memory` @
`1e80ca7b44bccd06c6da75ed9ca6ba497bd380f5`, MIT — see `UPSTREAM.md`). Plugin
id: `memory-fork`; CLI: `bb memory`. The bundled official `memory` plugin is
NOT installed where this fork is used (the CLI name would collide).

## Fork additions

- **`bot` scope** — durable knowledge owned by a stable BB bot id, shared
  across that bot's threads, invisible to other bots. Ownership is resolved
  live server-side via the `bots-sidebar` plugin RPC `resolveBotForThread`;
  the agent tool uses BB per-call context. There is no cwd/thread-name hashing.
  See the authorization limitation below before treating CLI/RPC as a security boundary.
- **`recall` agent tool** — search bounded summaries or retrieve a complete
  record by stable ID, including version. Uses the CLI's shared search/get/scope
  implementation, with live host-context bot resolution and quarantine exclusion.
- **`learn` agent tool** — BB-side durable learning write for agents whose
  native memory backend is disabled (BB-hosted OMP runs `memory.backend: off`
  via a launch overlay). Writes bot/project/global memory with provenance;
  an optional skill payload creates a managed skill after authored-name checks.
  Refusal or a failed skill write rolls back the learning record.
- **Proposals / dreaming** — `bb memory proposal create|list|show|approve|
  reject|cancel|apply|rollback` and `bb memory dream start|finish` + `bb memory
  dreams status`. Proposals are pending-only until a human (or an authorized
  reviewer) approves; apply is exactly-once with optimistic versioning, an
  audit trail via `memory_history`, and snapshot rollback. Skill proposals
  write versioned managed skills under `~/.omp/agent/managed-skills` with
  refuse-on-drift rollback.
- **Mnemopi migration** — `bb memory migrate inspect` (read-only bank scan)
  and `bb memory migrate import --plan <file>` (only plan-listed records,
  idempotent by name, full provenance in `writeReason`). Transcript-style
  episodic rows are excluded; only learn records and `llm_used` episodic rows
  surface as candidates. Original Mnemopi stores are never modified.

## Update path from upstream

1. `git clone --depth 1 --filter=blob:none --sparse https://github.com/get-bb/bb` →
   `git sparse-checkout set plugins/memory`.
2. Diff upstream `server.ts`, `app.tsx`, `memory-kinds.ts`, `skills/memory/SKILL.md`
   against this repo; port upstream fixes, keep fork additions (search for
   `owner_bot_id`, `ProposalStore`, `learn`).
3. Port reviewed changes into `bb-plugins/memory-fork` in dotfiles, bump `version`
   when needed, run `npm test`, `bb plugin build`, then `bb plugin reload memory-fork`.
   The canonical source is this dotfiles directory; relocate an existing install
   with `bb plugin install /absolute/path/to/dotfiles/bb-plugins/memory-fork --yes`.
   Preserve the original standalone checkout as a historical safety copy.

## Operations

- Data: BB plugin storage (`<dataDir>/plugins/memory-fork/data.db`), append-only
  migrations, soft-delete + version history. Soft-delete is NOT secure erasure.
- Migration exports/plans may contain personal memory content: keep them out
  of git (`migrate inspect` output is written to local files only).
- Disabling this plugin alone does not remove the RPC provider's overlay or
  the configured ACP launch arguments. See the rollback steps below.

## OMP transport cutover

RPC provider `omp` supplies a process-local config overlay with
`memory.backend: off` and `autolearn.autoContinue: false`. OMP's supported
backend switch removes its native recall/retain/reflect/edit devices.
BB `recall` and `learn` are provided separately by this plugin.
No denial-only replacement tools are registered. Native `manage_skill` stays
available; the automatic private capture continuation is disabled.

This plugin's host entry atomically writes the same overlay on the execution
host and contributes `PI_CONFIG_FILES` to `acp-omp` using BB's provider env hook.
The installed ACP provider is the built-in provider-acp on BB 0.47.1. Its
supported custom agent command additionally requires that overlay with
`omp acp --config <host-data>/bb-memory-overlay.json`, so an unavailable hook
cannot silently launch native memory. The configured path is specific to the
current host; other hosts fail until configured. Neither path edits global OMP
settings. Standalone OMP continues using its configured native backend.

Recall uses the registered `recall` tool (or `bb memory search/get`); retain
uses `learn` or `bb memory add`. Agent corrections use `learn` correction mode
and enter the existing review queue immediately.
Reflection is retrieval followed by reasoning, with reviewed changes proposed
explicitly. There is no second native memory store or automatic learner writer.

## Agent tool contract

The bundled skill documents the tools; reading a skill is not required to call
these registered capabilities. Keep the official Memory plugin disabled here
because its CLI/tool names may collide. Native OMP memory devices are absent
in both BB transports while the backend overlay is off.

```js
recall({query: "SQLite tests", scope: "all", limit: 5})
recall({id: "mem_..."})
learn({reason: "The cited command was removed", correction: {
  id: "mem_...", expectedVersion: 2
}})
learn({reason: "Verified against the current repository", correction: {
  id: "mem_...", expectedVersion: 2,
  replacement: {summary: "Use npm test", details: "Run npm test from the repository root."}
}})
```

`recall` accepts exactly one of `query` (1–400 characters) and `id` (stable
memory ID, not a name). Scope is `all` (default), `global`, `project`, or `bot`;
`all` means the existing global/current-project/current-bot union. Search
returns JSON `{ok, query, scope, memories, limit}` with summary fields including
stable `id` and `version`; `limit` is 1–20, default 5. ID lookup returns
`{ok, scope, memory}` with the full details, provenance, timestamps and version.
Inaccessible, deleted and quarantined IDs fail without disclosing their content.
Identity parameters are not accepted; live bot binding comes from BB's per-call
host context. Ownership lookup failure fails closed, including for corrections.

Fresh `learn` payloads and optional managed skills retain their existing
behavior/defaults. Correction mode accepts **only** `reason` (1–500 characters)
and `correction: {id, expectedVersion, replacement?}`. Version must be a
positive safe integer matching the accessible, non-quarantined target now.
An explicit replacement requires both `summary` and complete `details`;
optional name, kind, tags, importance and pinned fields otherwise preserve the
target metadata. Scope/owner/project are inherited from the target and cannot
be supplied by the agent. A replacement creates an existing `supersede`
proposal. Omitting replacement creates an existing `retire` candidate marked
`wrong-only-report`: it is an unverified report, not a correctness verdict or
an invented replacement. A reviewer must explicitly accept retirement before
apply can remove the record; rejecting leaves the original intact.

Correction returns JSON `{ok, created, proposal, canonicalUnchanged: true,
reviewRequired: true}`. Proposals are immediately pending in Settings → Memory
Fork → Proposals & dreams, with agent provenance, reason, source thread/bot,
and source record ID/version. View source shows the current canonical record.
No scheduled dream run is needed and no product path auto-approves. Existing
strict approve/apply/rollback gates and optimistic version checks still apply.
This agent-tool path does not fix the SDK CLI/RPC identity limitation tracked
by MEMORYPLUG-8.

## Review, scan and recovery

Settings → Memory Fork includes pending, approved, rejected, cancelled, applied
and rolled-back proposal filters. Approve and apply both validate strict action
payloads, target IDs, scopes and expected versions. Approved stale/invalid work
can be cancelled with a reason. Apply is transactional for memory records;
rollback checks every post-apply version and removes a supersede replacement.
Legacy applied proposals without post-apply versions refuse blind rollback.
Managed skill proposals require `skillName`, `body` and `expectedSha256`
(null for a new skill), and protect authored names and later skill edits.

The single existing weekly script is refreshed from `scripts/dream-run.mjs`.
It uses a bounded chronological `dream scan`, complete same-scope peers and a
versioned snapshot cursor with `(updatedAt,id)` pagination, rather than a
thread-local ranked catalog. The snapshot excludes the current millisecond,
keeps its upper bound across pages, and defers concurrent writes to the next
window. Legacy tuple/ISO cursors are upgraded by safely replaying their boundary.
It proposes exact-content duplicates only, preserves details, records decision
fingerprints and checkpoints after durable proposal writes. See
[`scripts/DREAMING.md`](scripts/DREAMING.md) and the isolated acceptance script.
All migrated imports remain unreviewed or quarantined until substantive review;
byte equality is provenance, not current semantic correctness. Quarantined
records are excluded from catalog, search, get, history and dream scans. Explicit
Settings deletion can soft-delete a quarantined record with version/history
preservation; scoped agent deletion still refuses it.

## Current authorization limitation

The installed SDK authenticates agent-tool context and plugin identity, but
client RPC does not distinguish a human UI operator from an agent client. CLI
thread/project context is request-supplied. Administrative commands reject a
normal agent thread context, but omission/spoofing is not prevented by the SDK.
Settings RPC and Bots Sidebar's memory RPC share that known limitation,
tracked separately by MEMORYPLUG-8; this task does not repair the SDK boundary.
Do not treat these surfaces as an authenticated privacy boundary. Bot-private
summaries are withheld from synchronous instruction injection because cached
bindings cannot universally authorize disclosure; scoped reads resolve live.
Previously loaded sessions cannot retract already supplied instructions.

## Rollback

Preserve the memory DB and history. Reloading a source checkout is supported;
no service restart is required. Revert the task's source commits and rebuild /
reload the two local plugins. Before removing the memory-fork host overlay,
restore provider-acp's saved `customAgents` value (empty string on this host).
Do not overwrite other configured custom agents or global OMP config. Reverting
the RPC cutover re-enables native memory for future child processes; existing
sessions may need a new conversation. Restore the saved automation script with
`bb automation update <id> --project proj_personal --script-file <saved-file>`
and preserve its one enabled Sunday 03:30 America/Los_Angeles schedule.
