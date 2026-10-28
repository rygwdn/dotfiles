# Continuity

Opt-in, per-thread context maintenance for BB's `omp` (RPC, plugin `provider-omp`) and `acp-omp` providers. BB owns policy and controls; an extension inside the existing OMP process owns model-facing projection and invokes OMP's native soft compactor. No second process resumes the session.

## Requirements and strategy

- BB with Plugin SDK 0.6.49-compatible host entries and provider environment contributions.
- OMP 18.12 extension APIs. Actual ACP smoke verification used OMP **18.12.3**; source contracts were checked against 18.12.1.
- Native experimental context management must be enabled **before provider startup**, with `context_notes`, `new_context`, `read`, and `grep` active. The extension refuses maintenance if those tools are absent. In this mode OMP avoids its usual destructive tool-output pruning. For an otherwise unconfigured workspace, the relevant native setting is:

  ```yaml
  compaction:
    experimentalContextManagement: true
  ```

  Continuity does not edit existing OMP configuration files to enable this setting. Configure it deliberately through OMP, then restart the provider. Sessions already exposing the notes/history tools need no additional setting change.

**History-first strategy:** automatic pressure handling uses OMP's notes-backed rollover; idle summaries explicitly call native `soft` compaction. This deliberately replaces automatic speculative summaries while enabled. OMP's native notes instructions and notebook remain in charge of notes updates; Continuity does not invent a second summarizer or automatically author notes.

Continuity's projection and its soft summaries leave original tool-result bodies in the active branch journal. They cannot recover results already rewritten before activation, and cannot prevent a user's explicit destructive native operation or another extension from rewriting history.

## Build and install

```sh
npm ci
npm run build
npm run typecheck
npm test
```

`npm run build` first bundles `omp-extension.ts`, then builds BB's server, app, and host artifacts. `generated/extension-source.ts` is the host's embedded runtime source; regenerate it whenever the extension, policy, schema, or file transport changes. Keep generated source with a source distribution because BB-managed installs can invoke `bb plugin build` directly without the npm build script. `generated/omp-extension.mjs` is also emitted for inspection.

The generated runtime carries a SHA-256 fingerprint of its runtime source inputs and dependency lockfile. `configure` and provider environment preparation reject an unstamped or stale embedded runtime before writing it to a host. Bare `bb plugin build` cannot bypass this guard; regenerate with `bun run build`. Source distributions must include the runtime input files, not just `dist/`.

The canonical source is `bb-plugins/continuity` in dotfiles. Use `bb plugin install /absolute/path/to/dotfiles/bb-plugins/continuity --yes` to move the existing installation while preserving its settings and private data. Building alone does not install or enable the plugin. The original standalone checkout remains a historical safety copy.

## Controls

Open **Continuity** in a thread's panel actions, or open its sidebar page and enter a BB thread ID. Save the enabled policy to opt in. New providers load the gated workspace extension at launch; an already-running provider without it requires its next user-controlled restart. Saving never starts/restarts a provider or interrupts a running turn. Later policy changes reach a loaded extension within two seconds.

Creation integrations can call the `setEnabled` RPC with `{ threadId, enabled }`
before workspace provisioning or provider launch. It validates the OMP provider
and saves the existing policy with the selected enabled state, without touching
the workspace. The provider environment contributor prepares the extension on
initial launch. Unlike `configure`, this API does not install into an already
running workspace; use the existing settings flow for live sessions.

```sh
bb continuity status thr_example --json
bb continuity enable thr_example --json
bb continuity compact thr_example --json
bb continuity disable thr_example --json
```

A request is queued, not proof that a summary ran. It waits for idle, no pending work, and the 15-minute attempt cooldown. The current runtime consumes a manual request before invoking `ctx.compact`; failures and completed attempts both consume it. Runtime status does not durably report the outcome of each request.

Native compaction failures remain visible as `error` with the same reason on subsequent idle heartbeats; `updatedAt` continues advancing. New user input, a new agent turn, a session transition, or a new actual maintenance attempt clears this in-process error latch. Merely polling, changing policy, or queuing a request still blocked by cooldown does not hide it. Disabling/stopping remains visible as disabled/stopped. This is not a durable per-request outcome ledger and does not add retries.

### Ownership and maintenance acceptance boundary

BB owns policy, scheduling and request delivery; the resident OMP extension owns idle/busy checks, cooldown enforcement, and invoking native soft compaction. OMP owns the compaction operation and its outcome callbacks. A queued request is not completion evidence.

**Proposed; not yet implemented:** every accepted manual request has a durable request ID and explicit queued, attempted, and terminal outcome (success, failure, or superseded); status identifies that request and its timestamps/outcome. Restart recovery must preserve whether a request is still pending or already attempted, without replaying a consumed attempt. The existing 15-minute attempt cooldown remains durable across restart. Persist only the latest operation plus a bounded recent history; reject or visibly mark stale/superseded requests rather than silently claiming success. Acceptance requires focused tests for success, callback failure, restart in queued/attempted states, request replacement, and cooldown boundaries. This proposal does not change current behavior or claim these guarantees exist.

Disabling restores the prior native runtime settings, including native pruning behavior. Normal BB plugin disposal also writes disabled control state for configured resident runtimes. If a host is unreachable, disposal logs the failure; do not assume the offline runtime acknowledged a disable.

The `reconcile` background service remains resident until its abort signal, rescanning desired policies every five seconds. It writes only host control files (`compact:false`), including policies saved after startup, and never starts/resumes/restarts providers. Reload disposal temporarily disables loaded runtimes; the replacement service restores saved desired policies within a scan interval. This can briefly restore native pruning settings, but does not cancel an in-flight compaction. Unreachable hosts remain unacknowledged and are retried.

`policy.tools` is accepted and preserved as configuration, **not enforced as an agent-tool allowlist**. No supported `tools.allowed` registry contract is relied on: Continuity removes the swallowed override attempt rather than claiming BB-side enforcement. The actual runtime prerequisite remains active `context_notes`, `new_context`, `read`, and `grep`; configure provider tool permissions separately.

## Thread UI indicators

The header Layers glyph, composer banner, and sidebar glyph show saved enablement even when OMP is stopped or its status becomes stale. Clicking the header glyph opens the thread's Continuity panel. Disabling the policy hides the indicators. A fresh runtime (15 seconds) controls running/error tones; a stopped or stale snapshot never advertises active compaction. The stopped label retains the saved last-compaction time when available.

The existing two-second managed interval also refreshes status while a native summary is awaiting completion, so long compactions remain live without extending a stopped/stale phase. A terminal snapshot older than a newly queued request cannot consume that request.

The batch `statuses` RPC returns both saved `enabledThreadIds` and the last host runtime snapshots. Header and composer refresh on mount, relevant realtime signals, policy changes, and every five seconds. Responses are scoped to the selected thread and late responses from previous navigation are ignored. The sidebar uses the same view rules with its existing bounded batch polling and feature-detected `experimental_setThreadRowStatus` surface.

On native `omp` (RPC), a Continuity-owned compaction attempts a notification from OMP's committed `session_compact` hook; a received notification produces a native **Context compacted** timeline boundary. Requested and automatic idle summaries share this path. A small versioned notification carries only the committed OMP session/entry identity, timestamp and trigger to provider-omp; no summary or transcript is transmitted. Each boundary gets its own synthetic provider turn so repeated compactions between user turns stay separate and no user turn is settled. Native `/compact` and automatic rollover retain their existing provider lifecycle markers rather than producing a second Continuity marker.

The checkpoint records the last committed entry identity and time. The notification is emitted once at commit, never on polling, status load, provider resume, or plugin reload. BB persists the resulting ordinary compaction events and reconstructs the same row during timeline replay. There is no notification outbox/retry or historical scan: compactions completed before this implementation (or lost before transport delivery) cannot be reconstructed from the old latest-time-only status file, so no boundaries are fabricated for them. Existing resident OMP processes load the updated hook at their next user-controlled restart.

The host status watcher (five-second polling fallback, 30-second signal heartbeat) and `requested`/`changed` realtime signals remain unchanged. Queued requests made inside OMP have no `requested` ping and become visible on their next runtime publish.

ACP limitation: OMP's ACP extension `notify` only writes a debug log; it emits no client notification or compaction lifecycle message. The BB SDK has no arbitrary timeline-append primitive for a non-provider plugin, and timeline renderers are restricted to a plugin's own provider rows. Therefore `acp-omp` receives the persistent indicators, but Continuity-owned requested/idle compactions do not reach the timeline through this notification path. BB's existing explicit `bb thread compact` / native `/compact` ACP wrapper is a separate supported path that already emits native compaction lifecycle rows. No BB core or ACP provider changes are made.

ACP Continuity-owned boundaries remain unresolved pending a supported passive compaction-event ingest/append primitive or ACP adapter/provider plumbing. The existing native notification path also has a documented no-outbox loss window: a crash or failed delivery between the real commit and notification receipt can permanently lose the marker because the source checkpoint already records that commit. Persisted BB markers are durable once delivered; this does not promise reliable delivery across that window. A generated-bundle failure reproducer confirms it. No outbox, retry worker, pending-queue scaffold, or host/core mutation is added in this patch.

## Projection policy

- Keep user/assistant messages and tool-call/result pairing. Protect recent complete tool rounds and a recent token budget, incomplete parallel batches, errors, media/non-text results, skill reads, notes, questions, and recovery results. Bootstrap results before the first user message are never demoted.
- Only unambiguously matched original journal results are candidates. Entry IDs, not content hashes or tool-call IDs alone, identify references. Duplicate tool-call IDs fail open.
- Wait for the configured cold-interval heuristic before **new** projection decisions. This is not observed provider cache expiry. No attempt is made to infer a provider's cache lookback. No warm prefix is deliberately rewritten.
- Require enough context, minimum result size, minimum reclamation, and subsequent regrowth. Existing projection bytes replay unchanged across warm requests and process resume; the cold interval never turns an existing stub back into full content.
- Persist projection metadata as branch-bound OMP custom journal entries. No transcript sidecar, placeholder-restoration regex, or independent archive.
- Read referenced originals with `continuity_read({id, offset, limit})`. Offsets and limits are **characters**, with at most 12,000 characters per page. The tool resolves only text results on the current branch, including history retained before native soft compaction. Native `history://current/full` remains available in notes-backed mode.
  In OMP's deferred tool interface, discover its schema with `read` on `xd://continuity_read`, then invoke it by writing the JSON arguments to that URI. It need not appear as a direct model tool.

Default budgets: six recent tool rounds; 8,000-token protected tail; 32,000-token projection trigger; 1,000-token minimum result; 8,000-token minimum reclaim; 16,000-token regrowth; one-hour cold heuristic. Result sizes and reclaimed tokens are proportional allocations of OMP's measured context usage by serialized character count, not tokenizer measurements or billed savings.

## Idle maintenance and cost boundaries

The resident extension checks controls every two seconds. Automatic native soft compaction defaults to 15 minutes idle and at least 48,000 context tokens, retaining an 8,000-token native tail. It makes at most one automatic attempt per latest user-entry ID and applies a durable **15-minute attempt cooldown**, also to manual requests. Failed attempts do not spin in a retry loop. These are attempt/frequency bounds, **not a dollar spending cap**.

The final activity checks and native compactor invocation have no intervening await. OMP installs its own compaction lock before its first await. User input, live turns, pending messages, and running or undelivered asynchronous work defer maintenance. Calls suppress maintenance continuation. Native soft compaction can split an oversized turn into multiple summarizer requests; one attempt does not imply one model call.

Cache warming returns `stop` while enabled. There is no idle worker when the OMP process is gone: the runtime starts a fresh idle interval on resume, restores journal metadata, and reconciles queued requests. Stale/missing status is shown as no fresh runtime, not ready.

The extension API does not expose separate summarizer billing totals or an enforceable per-attempt dollar budget. The UI states that limitation and does not present projected-token estimates as actual maintenance usage or savings. Native provider reporting is the source for model charges.

## Host deployment and data

The host installs one exact, gated `.omp/extensions/bb-continuity.ts` wrapper in the selected workspace. It refuses existing non-matching content and symlinks in the deployment path. The wrapper has no behavior without both per-thread environment contributions. OMP resolves the host registry's static import in the wrapper; the dynamically selected bundled runtime receives that registry explicitly. Importing OMP packages transitively from an arbitrary `.mjs` fails in the standalone binary and is intentionally avoided.

Plugin-private host storage holds `threads/<BB-thread-id>/extension.mjs`, `control.json`, and `status.json`, not original transcripts. Files are atomically replaced with private permissions. BB thread IDs remain distinct from OMP session IDs. No credentials or provider API keys are added to environment contributions. No global OMP extension/configuration file is changed.

Build with `bun run build`, not bare `bb plugin build`: the package script first regenerates the embedded OMP extension from current source. Skipping that step can deploy a stale strict policy schema (for example, rejecting `policy.tools`). After deploying a rebuilt plugin, already-running OMP providers retain their loaded extension until their next restart; do not interrupt an active turn to refresh it.

## Verification performed

- Seven Bun policy tests: immutable originals, protected rounds, exact recovery ranges, hot-cache replay/resume, regrowth and reclamation, errors/skills/media/incomplete batches, bootstrap protection, branch identity, and ambiguous IDs.
- Production TypeScript typecheck with dependency checking enabled; BB server/app/host build.
- Official BB host/backend harnesses exercised real handlers and private temporary storage: safe/idempotent deployment, collision/symlink refusal, per-thread opt-in, provider environment contribution, RPC/CLI compaction requests, and disposal.
- Actual OMP 18.12.3 ACP process with a deterministic **loopback-only model fixture**, not a paid model: six projections; process restart and stable replay; exact original recovery; native soft compaction; managed idle-timer execution; active-turn deferral; no maintenance agent continuation. Native compaction made multiple summarizer requests, as documented.
- Real Chromium rendered the actual controls through the official frontend harness and BB-scoped built CSS; saving budgets, queuing a request, and disabling were exercised against the actual backend/host handlers. This was an isolated smoke surface, not a production BB deployment.

Temporary drivers, servers, browser tabs, and model endpoints were removed/stopped after verification. Test reports and smoke evidence are in the BB thread's storage, not shipped as plugin behavior.

## Prior art

Design patterns were independently adapted, not copied verbatim:

- [BB Auto Compact (MIT)](https://github.com/Dummy-pixel-hash/bb-plugin-auto-compact/blob/f580248bb0ea038187d0f542db9d0a4ab66d9c22/server.ts): idle-event integration, cooldowns, and unsupported-provider handling. Its generic BB compaction call is not assumed to work for OMP.
- [OpenClaw pruning](https://github.com/openclaw/openclaw/blob/cbfaa0d8b7dfb9b55aabd5db6fbe42c468036f35/docs/concepts/session-pruning.md) and [journal checkpoints (MIT)](https://github.com/openclaw/openclaw/blob/cbfaa0d8b7dfb9b55aabd5db6fbe42c468036f35/src/agents/embedded-agent-runner/cache-ttl-checkpoint.ts): original transcript retention, durable projection decisions, and TTL-gated new decisions with stable replay. Continuity uses a bounded snapshot rather than a checkpoint/delta subsystem.
- OMP's native context hook, managed timers, notes/history mode, `session.compacting`, and soft compactor supply the runtime mechanisms.
