---
name: ballast
description: "Report disk capacity or diagnose and relieve physical memory pressure on this machine. Use for available disk space, builds or tests failing from memory pressure, paging, or Ballast escalations."
---

# Memory pressure

Ballast reads physical memory and attributes it to process trees and BB
threads. Use its tools instead of `top`, `vm_stat`, `ps` or `memory_pressure`.

## Read the numbers first

`ballast_status` reports used, headroom, swap, compression, and the largest
consumers grouped by tree and by thread.

The number that matters is **headroom** — free plus clean file cache plus
purgeable — not "% used". A machine at 90% used with 6 GB of cached files is
healthy; the same machine with 400 MB of headroom and a non-zero paging rate is
in trouble. `memory_pressure`'s "free percentage" is not a substitute: it counts
inactive pages as free and stays reassuring while the machine swaps.

`paging in` above zero means the machine is already reading memory back off
disk. That is the signal to act on. Swap that is merely *resident* is not —
pages parked there since yesterday cost nothing.

## Disk capacity

Use `ballast_disk` or `bb ballast disk --json` for total, used, and available
bytes on the root and home filesystems, deduplicated by filesystem identity.
Read failures are reported per path. The panel also has a **Disk** tab.

Capacity reporting performs no directory scan. Use `ballast_disk` with
`projects: true` or `bb ballast disk --projects --json` for project metadata,
linked Git worktrees and associated non-archived BB threads. Pass `projectId`
and `measure: true`, or `bb ballast disk --project <id> --measure --json`,
for an explicit allocated-byte scan of one project's local paths.

Scans include ignored files and dependencies but do not follow symlinks or
cross filesystems. They stop at 100,000 entries or a five-second deadline
checked between filesystem calls; a slow call may exceed that deadline.
Partial readings are lower bounds. Root/home inventories are excluded.
Nested paths and hardlinks count once per project. Remote paths are listed
but not scanned. Thread associations are metadata, not ownership of bytes.
The report includes at most 500 environments and 500 non-archived threads per
project, with a warning if that cap is reached. No disk operation deletes
files or triggers memory relief. Reserved space and shared APFS capacity
mean totals are not additive.

## Relieve it

1. `ballast_plan` lists candidates with ids, graded `safe` or `disruptive`, plus
   anything refused and why.
2. **Prefer asking over killing.** If a BB thread is holding the memory, message
   it with `bb thread tell <id>` and ask it to close Playwright browsers and
   stop dev servers. That costs the thread a turn. Killing its processes costs
   its work.
3. `ballast_relieve` with `dryRun: true`, check the total, then apply.
4. Take `disruptive` candidates only when nothing else gets headroom above the
   threshold, and say which ones you took.

## The boundary

`ballast_relieve` takes only ids that `ballast_plan` minted, and re-checks each
one against the live process table before signalling it — a recycled PID is
refused, not killed.

It will only ever stop four kinds of process — headless browsers, dev servers,
test runners and build tools — and only when nothing can still be waiting on
them. In practice that means **orphaned**: reparented to init, so whatever
launched it is gone. The one exception is a headless browser idle at no CPU
past the configured window, which is the ordinary shape of a leak from a
finished suite.

Idle alone is never enough for anything else. A process with a live parent is
being held by it, and a build tool or language server sitting at 0% CPU is a
worker waiting for its next request, not a corpse.

Agents, BB itself, editors, interactive browsers, containers, system processes,
anything owned by another user, anything younger than a minute, anything on a
protected port, and anything it could not confidently classify are refused by
construction.

Do not use `kill`, `pkill` or `killall` to work around that boundary. If you
believe something outside it must be stopped, say so and let the user decide.

## Commands

```sh
bb ballast status              # pressure and the signals behind it
bb ballast disk --json         # root and home filesystem capacity
bb ballast disk --projects --json  # project paths, worktrees and threads
bb ballast disk --project <id> --measure --json  # bounded local inventory
bb ballast top --limit 20      # largest consumers, by tree and by thread
bb ballast plan                # candidates with ids
bb ballast relieve --safe      # dry run; add --yes to apply
bb ballast log                 # what the guard has done
bb ballast restore             # undo a concurrency throttle
```
