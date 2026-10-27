#!/usr/bin/env node
/** Bounded, review-only memory curation. See scripts/DREAMING.md. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export function options(argv) {
  const result = { dryRun: false, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") result.dryRun = true;
    else if (argv[i] === "--limit") {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 100)
        throw new Error("--limit must be an integer from 1 to 100");
      result.limit = Number(value);
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return result;
}

function cli(args) {
  const value = JSON.parse(execFileSync(process.env.BB_CLI || "bb", ["memory", ...args, "--json"], {
    encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  if (value.ok !== true) throw new Error("Memory command did not report success");
  return value;
}

function scopeKey(memory) {
  if (memory.scope === "global") return "global";
  if (memory.scope === "project" && memory.projectId) return `project:${memory.projectId}`;
  if (memory.scope === "bot" && memory.ownerBotId) return `bot:${memory.ownerBotId}`;
  throw new Error("Scan returned a record without a stable scope");
}

function validateMemory(memory) {
  scopeKey(memory);
  if (typeof memory.id !== "string" || !memory.id ||
      !Number.isSafeInteger(memory.version) || memory.version < 1 ||
      !Number.isSafeInteger(memory.updatedAt) || memory.updatedAt < 0 ||
      typeof memory.summary !== "string" || typeof memory.details !== "string" ||
      typeof memory.kind !== "string" || !Array.isArray(memory.tags) ||
      !memory.tags.every((tag) => typeof tag === "string") ||
      !Number.isInteger(memory.importance) || typeof memory.pinned !== "boolean")
    throw new Error("Dream scan must return full versioned records");
}

// Exact content equality is evidence of duplication, never evidence of truth.
// Different details, kinds, tags, or scope cause abstention. No text is executed.
function contentKey(memory) {
  return JSON.stringify([scopeKey(memory), memory.summary, memory.details,
    memory.kind, [...memory.tags].sort(), memory.importance, memory.pinned]);
}

export async function runDream({ command = cli, dryRun = false, limit = 50,
  now = () => Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid scan limit");
  const status = await command(["dreams", "status"]);
  const previous = status.lastRun;
  // Failed/running runs retain their INPUT checkpoint. A retry replays that page.
  const checkpoint = previous?.watermark ?? null;
  const runId = ["running", "failed"].includes(previous?.status)
    ? previous.run_id : `dream-${now()}-${randomUUID()}`;
  if (typeof runId !== "string" || !runId) throw new Error("Invalid dream run ID");
  let started = false;
  let stats;
  try {
    if (!dryRun) {
      await command(["dream", "start", "--run-id", runId,
        ...(checkpoint ? ["--watermark", checkpoint] : [])]);
      started = true;
    }
    // This operator-only API scopes peer lookup on the server. Catalog is a
    // thread-local, ranked/truncated view and cannot serve as a dream feed.
    const scan = await command(["dream", "scan", "--limit", String(limit),
      ...(checkpoint ? ["--watermark", checkpoint] : [])]);
    if (!Array.isArray(scan.memories) || scan.memories.length > limit ||
        !Array.isArray(scan.peers) || scan.peers.length > 1000 ||
        typeof scan.watermark !== "string" || !scan.watermark ||
        typeof scan.hasMore !== "boolean") throw new Error("Invalid or unbounded dream scan response");
    const records = [...scan.memories, ...scan.peers];
    records.forEach(validateMemory);
    const changed = new Set(scan.memories.map((m) => m.id));
    const groups = new Map();
    for (const memory of records) {
      const key = contentKey(memory);
      const group = groups.get(key) ?? new Map();
      group.set(memory.id, memory);
      groups.set(key, group);
    }
    const history = await command(["proposal", "list", "--status", "all"]);
    // Legacy list is capped at 200. Refuse incomplete history rather than
    // resurrecting a rejected proposal outside that window.
    if (!Array.isArray(history.proposals) || history.proposals.length >= 200)
      throw new Error("Proposal history is truncated; bounded candidate lookup API required");
    let created = 0;
    let eligible = 0;
    const proposalIds = [];
    const used = new Set();
    for (const group of groups.values()) {
      const sorted = [...group.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      if (sorted.length < 2 || !sorted.some((m) => changed.has(m.id))) continue;
      const keep = sorted[0];
      for (const drop of sorted.slice(1)) {
        if (used.has(drop.id)) continue;
        // The keeper is never edited; multiple identical drops can share it.
        const fingerprint = createHash("sha256").update(JSON.stringify([
          "exact-content-v1", scopeKey(keep), ...[keep, drop].sort((a, b) => a.id.localeCompare(b.id))
            .map((m) => [m.id, m.version]),
        ])).digest("hex");
        if (history.proposals.some((p) => p.evidence?.fingerprint === fingerprint)) continue;
        used.add(drop.id); eligible++;
        if (dryRun) continue;
        const result = await command(["proposal", "create", "--action", "dedupe",
          "--targets", [keep.id, drop.id].sort().join(","),
          "--payload", JSON.stringify({ keepId: keep.id, keepExpectedVersion: keep.version,
            dropId: drop.id, dropExpectedVersion: drop.version }),
          "--evidence", JSON.stringify({ source: "dream-run.mjs", rule: "exact-content-v1",
            fingerprint, dreamRunId: runId, scope: scopeKey(keep), confidence: 1,
            uncertainty: "Identical stored content does not verify the underlying claim.",
            reason: "Full summary, details, kind, tags, importance and pinning match within the same scope; retain canonical details unchanged.",
            records: [keep, drop].map((m) => ({ id: m.id, version: m.version,
              updatedAt: m.updatedAt, reference: `bb memory get ${m.id}` })) }),
          // Store's pending uniqueness includes runId. Stable candidate identity
          // survives crashes and distinct dream runs; actual run is in evidence.
          "--run-id", `dream-candidate-${fingerprint}`]);
        if (result.created) created++;
        if (result.proposal?.id) proposalIds.push(result.proposal.id);
      }
    }
    stats = { scanned: scan.memories.length, peersInspected: scan.peers.length,
      proposalsEligible: eligible, proposalsCreated: created, proposalIds,
      hasMore: scan.hasMore, watermark: scan.watermark };
    if (!dryRun) await command(["dream", "finish", "--run-id", runId,
      "--status", created ? "succeeded" : "quiet", "--watermark", scan.watermark,
      "--stats-json", JSON.stringify(stats)]);
    return { ok: true, runId, dryRun, ...stats };
  } catch (error) {
    if (started) {
      // Never persist the output checkpoint until ALL proposals on the page are
      // durable. Failure leaves the input cursor for idempotent replay.
      try { await command(["dream", "finish", "--run-id", runId, "--status", "failed",
        ...(checkpoint ? ["--watermark", checkpoint] : []),
        "--stats-json", JSON.stringify({ error: "Dream page failed; input checkpoint retained" })]); }
      catch { /* Preserve the original error; running state also resumes. */ }
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runDream(options(process.argv.slice(2)));
    // Automation runtime treats an empty successful output as a silent tick.
    if (result.dryRun || result.proposalsCreated) console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Memory dream failed: ${error.message}`);
    process.exitCode = 1;
  }
}
