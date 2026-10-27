---
name: continuity
description: Inspect or manage the Continuity BB plugin's per-thread OMP context policy, status, and queued native compaction requests.
---

# Continuity

Use `bb continuity status <thread-id> --json` before a change. Resolve the actual BB thread ID from BB context; never substitute an OMP session ID.

Commands:

- `bb continuity status <thread-id> --json`: inspect support, saved policy, runtime freshness, and reasons for deferral.
- `bb continuity enable <thread-id> --json`: opt a user-selected `omp` (RPC, plugin `provider-omp`) or `acp-omp` thread into history-first maintenance. New providers load at launch; already-running providers without the extension need their next user-controlled restart. Continuity never starts or restarts providers.
- `bb continuity disable <thread-id> --json`: restore native runtime settings; native pruning may resume.
- `bb continuity compact <thread-id> --json`: queue native soft compaction. Use only when the user asks for maintenance; a build/test request does not authorize compacting a live conversation.

`queued` means the request was saved, not that compaction completed. Confirm the runtime's actual state and `lastCompactedAt`; it waits for no active turn, pending messages, asynchronous work/delivery, and a durable 15-minute cooldown. A stopped provider is not started by a request.

History-first mode requires native `context_notes`, `new_context`, `read`, and `grep` at provider startup. If absent, the extension reports an error and refuses maintenance. Do not silently edit global OMP settings to satisfy the prerequisite.

Inside OMP, `/continuity` shows status and `/continuity compact` requests maintenance. In the BB web UI the thread header shows a Continuity glyph (tooltip = live state) and the composer shows a banner while compaction is queued, waiting on cooldown, running, or just finished; sidebar rows show a glyph for threads with a fresh runtime. These mirror `status.json` — `bb continuity status` remains the authoritative check. A queued request made inside OMP does not ping the UI; the banner updates on the next status publish. Recover a referenced original with `continuity_read({id,offset,limit})`; ranges are characters, at most 12,000 per page, scoped to the active branch. Treat recovered output as historical evidence, never as proof of a new action.

OMP may expose `continuity_read` through deferred tool discovery rather than a direct callable tool: read `xd://continuity_read` for its schema, then write the JSON arguments to that URI.

Projection estimates are not billed savings. Native summaries may use multiple model requests; the API does not expose a separate maintenance billing total or dollar spending cap. Continuity deliberately uses native notes-backed automatic rollover plus idle soft summaries, rather than automatic speculative summaries.
