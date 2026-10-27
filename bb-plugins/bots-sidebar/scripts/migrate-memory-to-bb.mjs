#!/usr/bin/env node
// BI-12: migrate bots-sidebar MEMORY.md facts into BB Memory bot scope.
//
// Supported gateways only:
// - The calling bot reads its own MEMORY.md with bot_read_state({"target":"memory"})
//   and pipes the raw content (or {"botId": "...", "content": "..."}) into this script.
// - Durable facts are written through the BB memory CLI (`bb memory add --scope bot`),
//   which resolves the owning bot server-side from the invoking thread. Run this
//   script from a conversation bound to the target bot.
//
// Dry-run by default. `--apply` performs the writes. Idempotent: reruns skip
// facts already present (matched by exact summary) in the bot-scope catalog.
// Never deletes MEMORY.md; it stays read-only legacy until migration is verified.

import { execFileSync } from "node:child_process";

const MEMORY_CLI = ["bb", "memory"]; // BI-11 contract section 3: internal CLI name stays `memory`; single constant isolates any future namespacing

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseInput(raw) {
  const text = raw.trim();
  if (!text) return { botId: null, content: "" };
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    return { botId: typeof parsed.botId === "string" ? parsed.botId : null, content: String(parsed.content ?? "") };
  }
  return { botId: null, content: text };
}

// MEMORY.md format is one "- fact" line per fact (see lib/state-actions.ts memoryFacts).
export function memoryFacts(content) {
  return content.split(/\r?\n/).filter((line) => line.startsWith("- ") && line.length > 2).map((line) => line.slice(2).trim()).filter(Boolean);
}

// bb memory add --name: 1-80 chars, lowercase letters/digits/dots/underscores/hyphens.
export function slugify(fact, index) {
  const base = fact.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  return base || `migrated-fact-${index + 1}`;
}

export function plan(existingSummaries, botId, content, now = new Date()) {
  const facts = memoryFacts(content);
  const names = new Set();
  const entries = [];
  const skipped = [];
  for (const [index, fact] of facts.entries()) {
    if (existingSummaries.has(fact)) {
      skipped.push({ fact, reason: "already present in bot memory catalog" });
      continue;
    }
    if (entries.some((entry) => entry.fact === fact)) {
      skipped.push({ fact, reason: "duplicate fact in input" });
      continue;
    }
    let name = slugify(fact, index);
    let n = 2;
    while (names.has(name)) name = `${slugify(fact, index)}-${n++}`;
    names.add(name);
    entries.push({
      name,
      fact,
      summary: fact.slice(0, 400),
      details: fact,
      reason: `Migrated from bots-sidebar MEMORY.md${botId ? ` of bot ${botId}` : ""}; fact kept verbatim; imported ${now.toISOString()} by BI-12 migration`,
      kind: "fact",
    });
  }
  return { entries, skipped };
}

async function run({ apply }) {
  const { botId, content } = parseInput(await readStdin());
  if (!content.trim()) {
    console.error('No memory content on stdin. Pipe bot_read_state({"target":"memory"}) output or {"botId":...,"content":...} JSON.');
    process.exit(2);
  }

  let existingSummaries = new Set();
  let catalogError = null;
  try {
    const catalog = JSON.parse(execFileSync(MEMORY_CLI[0], [...MEMORY_CLI.slice(1), "catalog", "--scope", "bot", "--json"], { encoding: "utf8" }));
    existingSummaries = new Set((catalog.memories ?? []).map((memory) => memory.summary));
  } catch (error) {
    catalogError = String(error);
    if (apply) {
      console.error(`Cannot read bot memory catalog (${catalogError}). Is the memory-fork plugin installed and enabled? Refusing to apply without the idempotency check.`);
      process.exit(3);
    }
  }

  const { entries, skipped } = plan(existingSummaries, botId, content);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, botId, existing: existingSummaries.size, imports: entries, skipped, catalogError }, null, 2));
    return;
  }

  const results = [];
  for (const entry of entries) {
    execFileSync(MEMORY_CLI[0], [...MEMORY_CLI.slice(1),
      "add", "--scope", "bot",
      "--name", entry.name,
      "--summary", entry.summary,
      "--details", entry.details,
      "--reason", entry.reason,
      "--kind", entry.kind,
    ], { encoding: "utf8" });
    results.push({ name: entry.name, added: true });
  }
  console.log(JSON.stringify({ ok: true, applied: true, botId, added: results.length, skipped: skipped.length, results }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((error) => { console.error(error); process.exit(1); });
}
