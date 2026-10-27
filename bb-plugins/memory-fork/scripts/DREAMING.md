# Bounded dream runner

`dream-run.mjs` proposes exact duplicate memories for human review. It never
approves, applies, retires, rewrites details, promotes scope, or edits a skill.
Identical content is evidence of duplication, not verification of a claim.
Different details, kinds, tags, importance, pinning or stable scopes cause abstention. Task outcomes
and skill synthesis still require explicit evidence review; this deterministic
pass does not claim to perform those reasoning workflows.

## Operator interface

Run in the trusted script/operator context, with no `BB_THREAD_ID`:

```sh
node scripts/dream-run.mjs --dry-run --limit 50
node scripts/dream-run.mjs --limit 50
```

Do not unset a live agent's identity to bypass access controls. The integration
owner executes operator checks or uses the existing automation runtime. A dry
run scans and reports counts without writing proposals or dream state.
`--limit` must be an integer from 1 through 100 (default 50). Each invocation
processes one page. A continuation is visible as `stats_json.hasMore` in
`bb memory dreams status --json`; invoke again to drain a backlog. The weekly
job can also continue at its next tick. Output contains counts/IDs/checkpoint,
not memory bodies. A successful run without new proposals is silent, so BB's
existing script automation records a skipped tick. Errors exit nonzero; BB
captures them and its existing retry/failure policy applies.

The enabled automation is `auto_7bkoh7au9y4`, Personal,
`30 3 * * 0`, `America/Los_Angeles`. The runner in the automation is a stored
copy; changing this repository does **not** update it. After core integration
and acceptance, the integration owner refreshes that existing automation with
`bb automation update` using `--script-file scripts/dream-run.mjs` and the
existing execution settings. Preserve its ID, schedule and working directory;
do not create a second automation or a new service.

## Why the previous run scanned zero

The inspected Personal automation had no bound thread. Normal
`bb memory catalog --scope all` means global plus the *current* project and
bound bot, not every project and bot. Its JSON was correctly shaped as
`{ok:true,memories:[],total:0}`. A bot-bound worker could see bot records, but
that did not reproduce the automation context. The runner incorrectly treated
that empty view as a successful scan and wrote the epoch watermark.

Catalog is also sorted for retrieval and capped at 100. Treating it as a feed
could skip older low-ranked records permanently. The operator-only dream scan
API supplies an ordered, bounded change feed and exact-scope peers instead.
The stale stored script also grouped only changed records, so an old duplicate
peer could be missed; its generated `mergedDetails` used summaries in place of
full details. The new runner preserves the keeper's complete canonical details.

## Core API consumed by the runner

```text
bb memory dream scan --limit 50 [--watermark <opaque-string>] --json
{
  ok: true,
  memories: FullMemoryRecord[],
  peers: FullMemoryRecord[],
  watermark: string,
  hasMore: boolean
}
```

The server owns cursor encoding, validation and authorization. Scan is available
only to the trusted operator/script context, never an agent thread. It scans
alive, nonquarantined records across global, project and bot partitions without
expanding ordinary agent catalog/search access. Each full record includes
`id`, `scope`, `projectId`, `ownerBotId`, `summary`, `details`, `kind`, `tags`,
`version`, `importance`, `pinned`, and numeric millisecond `updatedAt`.

Changes are ordered by `(updatedAt,id)` within a stable upper bound. The cursor
must preserve the unfinished snapshot and last tuple; only a fully consumed
snapshot advances its completed watermark. Legacy ISO epoch checkpoints must
be accepted for recovery. Choose an upper bound before the current millisecond
to avoid missing records inserted later with the same timestamp. Peers are
full records with an exact matching summary within each changed record's exact
scope/owner/project partition. The server must fail explicitly if its bounded
peer result is incomplete. The runner accepts at most `limit` changed records
and 1000 peers, and rejects missing fields instead of silently scanning zero.

The runner writes the input checkpoint when starting. After all page proposals
are durable it finishes with the output checkpoint. A failure records `failed`
with the input checkpoint; a retry reuses the failed/running run's ID and page.
Successful executions get distinct IDs, including multiple runs on one day.
A stable SHA-256 of the rule, scope, target IDs and versions provides proposal
identity across execution IDs. Its deterministic proposal `runId` makes the
store's existing pending uniqueness useful across retries. The execution ID
is retained separately in evidence as `dreamRunId`.

Every proposal includes exact versions, source references, stable scope,
confidence, uncertainty and reason. No candidate text becomes an instruction.
Rejected/applied/cancelled/rolled-back candidates at the same versions are
suppressed using proposal history. The legacy history endpoint is capped at
200; the runner deliberately fails at that boundary rather than ignoring an
older decision. A future bounded fingerprint lookup can remove that limit.

## Acceptance and integration

The owner runs checks once after core integration:

```sh
bash scripts/dream-acceptance.sh
```

This script does not execute production `bb`. It loads the actual server and
CLI into the SDK test host backed by temporary SQLite, transpiling source in
memory with the installed TypeScript package. Home, managed-skill and plugin
data directories are isolated; disposal removes the temporary store. No build
output or authored skills are modified, and no dependency is installed.

The fixtures cover the actual empty Personal catalog, full scan pages, old-peer
lookup, identical content across distinct projects and bot owners, conflicting details,
instruction-like text, dry-run state preservation, review gating, terminal
rejection dedupe, approval/application/history/rollback, stale versions and
failure after a durable proposal write followed by resume. Invalid scan shapes
and ordinary agent access must fail. Assertions target IDs returned by the
isolated store; there is no first-pending selection against a live store.

Before **any** live fixture or proposal/canonical mutation, coordinate the
fixture scope/IDs and cleanup with the integration owner. A production dry run
and read-only automation/status inspection are permitted. Source checks alone
are not live acceptance. The owner should refresh the stored automation only
after the new core API is installed, run an operator dry run in the actual
threadless automation context, then coordinate one actual automation execution
and check its recorded counts/checkpoint. Do not assert that a repository edit
has already repaired the installed weekly job.

Rollback of this runner is a scoped Git revert plus refreshing the existing
stored automation from the chosen revision. That does not require SQL changes,
service restarts, or removal of existing proposals, history or memory records.

## Snapshot cursor implementation

The opaque v1 cursor contains `since` (completed inclusive milliseconds), and,
while a window is unfinished, `until` and `after: {updatedAt,id}`. A completed
window emits only `{v:1,since:until}`. The next window fixes its upper bound at
`Date.now()-1`; current-millisecond and later writes wait for the next window.
Both changed records and same-scope peers respect that bound. Empty scans advance
the completed boundary to the bounded scan time, rather than the epoch.

Legacy ISO and `{updatedAt,id}` inputs are accepted by replaying their entire
boundary millisecond. Stable proposal fingerprints suppress duplicates during
this upgrade. Malformed, negative, future, or inconsistent cursor values fail
explicitly. Callers must pass returned strings unchanged, not construct cursors.

The isolated acceptance now creates equal-millisecond writes during a frozen
clock, paginates an earlier window while another record arrives, and verifies
that no IDs repeat/skip and the later record appears only in the next window.
