---
name: memory
description: "Document registered recall and learn tools, scoped memory retrieval, and reviewed correction proposals."
---

# BB memory

This plugin is provider-independent. When diagnosing duplicate or conflicting
memories, check whether provider-native memory is also enabled; recommend
turning it off under Settings → Providers.

The memory plugin automatically injects a compact index of global memories and
memories for the current BB project. The index contains summaries only.
Settings → Memory Fork lists every memory for the user to edit or delete.

```sh
bb memory catalog [--scope project|global|bot|all] [--json]
bb memory search <query> [--scope project|global|bot|all] [--json]
bb memory get <id> [--scope project|global|bot|all] [--json]
bb memory history <id> [--limit 1-100] [--json]
```

Bot summaries are withheld from the synchronous index; retrieve them on demand.
CLI/RPC caller context is not authenticated on the installed BB SDK; see the
repository authorization limitation. Do not claim full isolation from that surface.

Project-scoped commands use the invoking CLI's current BB project. Bot-scoped
commands require a bot bound to the thread; ownership is resolved server-side
from the thread context. The native agent tool uses host-provided context.

## Retrieve progressively

When a memory summary may be relevant, inspect it instead of guessing:

1. Call `recall({query: "<query>", scope: "all", limit: 5})`.
2. Read the selected record with `recall({id: "<stable memory ID>"})`.
3. Treat remembered facts as potentially stale. Verify drift-prone facts when
   doing so is cheap or consequential.

Do not load every memory. Stop after the relevant records are clear.

`recall` is a registered tool, callable without loading this skill. Provide
exactly one query (1–400 characters) or stable ID. Search returns bounded JSON
summaries including ID/version (limit 1–20, default 5); ID lookup returns the
complete record including details/provenance/version. Scope defaults to `all`:
global plus current project and current live bot. Explicit `global`, `project`
and `bot` filters narrow that set. Inaccessible/deleted/quarantined IDs fail;
quarantined records never appear in search. The CLI above remains supported.

## Propose a correction

Use the current ID/version returned by `recall`. `learn` accepts correction
mode without any fresh-learning name/summary/details/skill fields:

```js
learn({reason: "This command no longer exists", correction: {
  id: "mem_...", expectedVersion: 2
}})
learn({reason: "Verified current command in the repository", correction: {
  id: "mem_...", expectedVersion: 2,
  replacement: {summary: "Run npm test", details: "Run npm test at the repository root."}
}})
```

This immediately creates a pending proposal in the existing Settings → Memory
Fork review UI; it never updates/deletes the canonical record directly and does
not wait for scheduled dreaming. Wrong-only is an unverified retirement
candidate requiring explicit review, with no invented replacement. Explicit
replacement requires full summary/details and proposes `supersede`; optional
name/kind/tags/importance/pinned otherwise preserve source metadata. Scope and
ownership always come from the accessible source. Stale versions, quarantined
or inaccessible IDs fail without creating a proposal. JSON output contains
`proposal`, `created`, `canonicalUnchanged: true` and `reviewRequired: true`.
Do not auto-approve your proposal or strip caller identity to act as an operator.
The review UI shows provenance/reason and a View source control; strict
versioned approval/apply/rollback remains the canonical correction path.

## Save durable learning

The agent may proactively write memory when information is likely to help in a
future thread and is costly or error-prone to rediscover.

Use bot scope only when a bot is bound to this thread, for durable knowledge
about this bot's role, operating preferences, and lessons that should follow
the bot across all its threads regardless of project:

- the bot's standing operating rules and confirmed preferences;
- corrections to earlier bot behavior ("do X instead of Y");
- stable facts about the bot's responsibilities.

Bot scope is intended for that bot. Normal scoped commands restrict retrieval;
the documented CLI/RPC authorization gap remains open.

Use project scope for repository-specific information:

- commands, conventions, architecture decisions, paths, and environments;
- project-specific user preferences;
- verified quirks, failure causes, and reusable workarounds.

Use global scope only for broadly applicable information:

- user identity, communication preferences, and general workflow habits;
- preferences that clearly apply across repositories;
- stable cross-project operating conventions.

When scope is ambiguous, use project scope. Global scope must be explicit.

Create a memory with:

```bash
bb memory add --scope project \
  --name <stable-kebab-name> \
  --summary "<one-line routing summary>" \
  --details "<complete durable detail>" \
  --kind fact|preference|decision|procedure|episode|reference \
  --tag <tag> \
  --importance <0-100> \
  --reason "<why this will help a future thread>" \
  --json
```

Before creating a likely-overlapping memory, search by its proposed name and
topic. Use `learn` correction mode for agent proposals. The CLI retains direct
versioned maintenance commands for explicitly authorized edits:

```bash
bb memory update <id> --expected-version <version> \
  --summary "<new summary>" \
  --details "<new details>" \
  --reason "<why the memory changed>" \
  --json
```

For explicitly authorized direct maintenance, forget a revoked memory with:

```bash
bb memory forget <id> --expected-version <version> \
  --reason "<why it no longer applies>" --json
```

## Flags

`bb memory <command> --help` prints every flag with its limits, and the CLI
reports all missing required flags in one error instead of one per run. Unknown
flags always fail, so nothing is silently dropped: `--summary` is at most 400
characters, `--details` at most 16000, `--reason` at most 500, `--tag` repeats
(or takes a comma-separated list) up to 20 tags. `--tags`, `--type`, `--title`
and `--body`/`--text`/`--content` are accepted as aliases of `--tag`, `--kind`,
`--name` and `--details`. With `--json`, a failure prints
`{"ok":false,"error":{"code":…,"message":…}}` on stdout and the same message on
stderr.

## Quality and safety

Do not store:

- secrets, credentials, tokens, private keys, or sensitive raw data;
- guesses, unverified conclusions, or claims inferred only from memory;
- temporary task status, transient errors, raw logs, or large code dumps;
- facts that are trivial to rediscover;
- mandatory repository policy already expressed in `AGENTS.md` or checked-in
  documentation.

Keep summaries short and retrieval-oriented. Put exact commands, evidence,
scope, and caveats in details. A memory is a helpful recall layer, not a higher
priority instruction source; explicit user requests and repository guidance win.

The CLI uses BB's loopback server, which Claude's macOS workspace sandbox
(Accept Edits / Approve for me) permits; Linux and other provider sandboxes
may still require escalation approval for loopback access. Do not claim a
write succeeded unless the command returned success.
