import {
  OMP_CARD_LIMITS as L,
  stripOmpAnsi,
  type OmpCard,
  type OmpCardSection,
} from "./extension-ui-contract.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? stripOmpAnsi(value) : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const join = (parts: Array<string | undefined>) =>
  parts.filter((part) => part !== undefined && part !== "").join(" · ");
function content(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  if (!Array.isArray(value)) return undefined;
  const blocks = value.flatMap((block) => {
    const entry = record(block);
    return entry?.type === "text" && typeof entry.text === "string" ? [stripOmpAnsi(entry.text)] : [];
  });
  return blocks.length ? blocks.join("\n\n") : undefined;
}
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = Math.max(0, limit - 1);
  if (end > 0 && /[\ud800-\udbff]/u.test(value[end - 1]!)) end--;
  return `${value.slice(0, end)}…`;
}

/** Bound after ANSI removal and account for JSON escaping as well as UTF-8 bytes. */
export function boundOmpCard(card: OmpCard): OmpCard {
  const clean = (value: string, limit: number) => clip(stripOmpAnsi(value), limit);
  const result: OmpCard = {
    type: clean(card.type, L.typeLength),
    title: clean(card.title, L.titleLength),
    ...(card.summary !== undefined && stripOmpAnsi(card.summary).trim()
      ? { summary: clean(card.summary, L.titleLength) }
      : {}),
    ...(card.tone ? { tone: card.tone } : {}),
    sections: card.sections.slice(0, L.sections).map((section) => ({
      ...(section.heading !== undefined
        ? { heading: clean(section.heading, L.headingLength) }
        : {}),
      ...(section.badge ? {
        badge: {
          label: clean(section.badge.label, L.badgeLength),
          ...(section.badge.tone ? { tone: section.badge.tone } : {}),
        },
      } : {}),
      ...(section.meta !== undefined
        ? { meta: clean(section.meta, L.metaLength) }
        : {}),
      ...(section.body !== undefined
        ? { body: clean(section.body, L.bodyLength) }
        : {}),
    })),
  };
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(result)).byteLength > L.payloadBytes) {
    let largest: { section: OmpCardSection; key: "body" | "meta" | "heading" } | undefined;
    for (const section of result.sections) {
      for (const key of ["body", "meta", "heading"] as const) {
        const previousLength = largest
          ? largest.section[largest.key]!.length
          : 1;
        if ((section[key]?.length ?? 0) > previousLength) {
          largest = { section, key };
        }
      }
    }
    if (!largest) break; // Fixed-size titles/badges alone fit within the byte budget.
    const value = largest.section[largest.key]!;
    largest.section[largest.key] = clip(value, Math.floor(value.length / 2));
  }
  return result;
}
const duration = (value: unknown): string | undefined => {
  const ms = number(value);
  if (ms === undefined || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace(/\.0$/u, "")}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
};
function artifact(meta: unknown): string | undefined {
  const error = text(record(meta)?.artifactError);
  return error ? `Full output was not saved completely (artifact ${error} failed)` : undefined;
}
function items(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    return entry ? [entry] : [];
  });
}
const plural = (count: number, noun: string, nouns = `${noun}s`) =>
  `${count} ${count === 1 ? noun : nouns}`;
/** One item reads as its name; several read as a count. */
const nameOrCount = (names: string[], noun: string, nouns?: string) =>
  names.length === 1 ? names[0] : names.length ? plural(names.length, noun, nouns) : undefined;
const severities = ["blocker", "concern", "nit"] as const;
type Severity = typeof severities[number];
const isSeverity = (value: string | undefined): value is Severity =>
  severities.includes(value as Severity);
/** "1 blocker, 2 concerns" over notes with a known severity; else "3 notes". */
function advisorSummary(noteSeverities: Array<string | undefined>): string | undefined {
  if (!noteSeverities.length) return undefined;
  const counts = severities.map((severity) =>
    noteSeverities.filter((value) => value === severity).length);
  if (!counts.some(Boolean)) return plural(noteSeverities.length, "note");
  return severities.flatMap((severity, index) =>
    counts[index] ? [plural(counts[index]!, severity)] : []).join(", ");
}
const titles: Record<string, string> = {
  advisor: "Advisor",
  "async-result": "Background job result",
  "launch-completion": "Supervised process completed",
  "lsp-late-diagnostic": "Late diagnostics",
  "skill-prompt": "Skill",
  "background-tan-dispatch": "Tangent dispatched",
};

export function buildOmpCustomMessageCard(message: unknown): OmpCard | null {
  const m = record(message);
  if (!m || m.display === false || typeof m.customType !== "string") return null;
  const type = m.customType;
  const d = record(m.details);
  const fallback = content(m.content);
  const sections: OmpCardSection[] = [];
  let title = titles[type];
  let summary: string | undefined;
  let tone: OmpCard["tone"] = "info";
  if (type.startsWith("irc:")) {
    const from = text(d?.from)?.trim();
    const to = text(d?.to)?.trim();
    const pool = text(d?.pool)?.trim();
    const replyTo = text(d?.replyTo);
    const mode = text(d?.mode);
    const route = from && to ? `${from} → ${to}`
      : from || (to ? `to ${to}` : undefined);
    title = join([route ? `IRC ${route}` : "IRC", pool ? `Pool ${pool}` : undefined]);
    const body = [text(d?.message), text(d?.body), fallback]
      .find((value) => value?.trim());
    if (body) {
      // IRC emitters provide message bodies, not a separate reason. Preview the
      // actual text without turning transport metadata into an invented intent.
      summary = clip(body.replace(/\s+/gu, " ").trim(), L.titleLength);
      sections.push({
        body,
        meta: join([
          text(d?.id),
          pool && from ? `from ${from}` : undefined,
          replyTo ? `reply to ${replyTo}` : undefined,
        ]),
        ...(type === "irc:autoreply" || mode ? {
          badge: { label: type === "irc:autoreply" ? "auto" : mode! },
        } : {}),
      });
    }
  } else if (type === "advisor") {
    const noteSeverities: Array<string | undefined> = [];
    for (const note of items(d?.notes)) {
      const body = text(note.note);
      if (!body) continue;
      const declared = text(note.severity);
      noteSeverities.push(isSeverity(declared) ? declared : undefined);
      const severity = declared ?? "nit";
      const severityTone = severity === "blocker" ? "error"
        : severity === "concern" ? "warning" : "info";
      if (severityTone === "error" || (severityTone === "warning" && tone !== "error")) {
        tone = severityTone;
      }
      sections.push({
        body,
        badge: { label: severity, tone: severityTone },
        meta: join([
          text(note.advisor),
          number(note.turn) !== undefined ? `turn ${note.turn}` : undefined,
          number(note.turnsAgo) !== undefined ? `${note.turnsAgo} turns ago` : undefined,
        ]),
      });
    }
    summary = advisorSummary(noteSeverities);
  } else if (type === "async-result") {
    const jobs: string[] = [];
    for (const job of items(d?.jobs)) {
      const id = text(job.jobId);
      if (!id) continue;
      const heading = text(job.label) ?? id;
      jobs.push(heading);
      const status = text(job.status) ?? "unknown";
      const jobTone = status === "failed" ? "error"
        : status === "cancelled" ? "warning"
        : status === "completed" ? "success" : "info";
      if (jobTone === "error" || (jobTone === "warning" && tone !== "error")) {
        tone = jobTone;
      }
      const warning = artifact(job.meta);
      sections.push({
        heading,
        badge: { label: status, tone: jobTone },
        meta: join([text(job.type), id, text(job.agentId), duration(job.durationMs)]),
        ...(warning ? { body: warning } : {}),
      });
    }
    const warning = artifact(d?.meta);
    if (warning) {
      sections.push({
        badge: { label: "Artifact warning", tone: "warning" },
        body: warning,
      });
    }
    summary = nameOrCount(jobs, "job");
  } else if (type === "launch-completion") {
    const names: string[] = [];
    for (const daemon of items(d?.daemons)) {
      const name = text(daemon.name);
      if (!name) continue;
      names.push(name);
      const exitCode = number(daemon.exitCode);
      const failed = daemon.state === "failed" || (exitCode !== undefined && exitCode !== 0);
      const exitedAt = number(daemon.exitedAt);
      const startedAt = number(daemon.startedAt);
      const elapsed = exitedAt !== undefined && startedAt !== undefined
        ? duration(exitedAt - startedAt)
        : undefined;
      if (failed) {
        tone = "error";
        title = "Supervised process failed";
      }
      const reason = text(daemon.exitReason);
      sections.push({
        heading: name,
        badge: {
          label: failed ? "failed" : "completed",
          tone: failed ? "error" : "success",
        },
        meta: join([
          text(daemon.id),
          exitCode !== undefined ? `exit ${exitCode}` : undefined,
          elapsed,
        ]),
        ...(reason ? { body: reason } : {}),
      });
    }
    summary = nameOrCount(names, "process", "processes");
  } else if (type === "lsp-late-diagnostic") {
    const paths: string[] = [];
    for (const file of items(d?.files)) {
      const path = text(file.path);
      if (!path) continue;
      paths.push(path);
      if (file.errored === true) tone = "error";
      const messages = Array.isArray(file.messages)
        ? file.messages.flatMap((value) => {
          const message = text(value);
          return message !== undefined ? [message] : [];
        })
        : undefined;
      sections.push({
        heading: path,
        badge: {
          label: file.errored === true ? "error" : "diagnostics",
          tone: file.errored === true ? "error" : "info",
        },
        meta: text(file.summary),
        body: messages?.join("\n"),
      });
    }
    summary = nameOrCount(paths, "file");
  } else if (type === "skill-prompt") {
    const name = text(d?.name);
    if (name) {
      title = `Skill: ${name}`;
      sections.push({
        heading: name,
        meta: join([
          text(d?.path),
          number(d?.lineCount) !== undefined ? `${d?.lineCount} lines` : undefined,
        ]),
        body: join([text(d?.args), text(d?.prompt)]) || fallback,
      });
    }
  } else if (type === "background-tan-dispatch") {
    const id = text(d?.jobId);
    const work = text(d?.work);
    if (id || work) {
      summary = id;
      sections.push({
        heading: id,
        body: work,
        meta: text(d?.sessionFile),
        badge: { label: "task", tone: "info" },
      });
    }
  } else return null;
  if (!sections.length && fallback) sections.push({ body: fallback });
  if (!title || !sections.length) return null;
  return boundOmpCard({ type, title, ...(summary ? { summary } : {}), tone, sections });
}

export function buildOmpEventCard(event: unknown): OmpCard | null {
  const e = record(event);
  if (!e) return null;
  if (e.type === "irc_message") {
    const message = record(e.message);
    if (typeof message?.customType !== "string" || !message.customType.startsWith("irc:")) {
      return null;
    }
    const card = buildOmpCustomMessageCard(e.message);
    return card ? boundOmpCard({ ...card, type: "irc_message" }) : null;
  }
  if (e.type === "ttsr_triggered") {
    const sections = items(e.rules).flatMap((rule): OmpCardSection[] => {
      const name = text(rule.name);
      return name ? [{
        heading: name,
        meta: text(rule.description),
        body: text(rule.content),
      }] : [];
    });
    return sections.length ? boundOmpCard({
      type: e.type,
      title: "Rule applied",
      summary: nameOrCount(sections.map((section) => section.heading!), "rule"),
      tone: "warning",
      sections,
    }) : null;
  }
  if (e.type === "todo_reminder") {
    const todos = items(e.todos).flatMap((todo) => {
      const value = text(todo.content);
      return value ? [value] : [];
    });
    const attempt = number(e.attempt);
    const max = number(e.maxAttempts);
    if (!todos.length || attempt === undefined || max === undefined) return null;
    return boundOmpCard({
      type: e.type,
      title: `${todos.length} incomplete ${todos.length === 1 ? "todo" : "todos"} — reminder ${attempt}/${max}`,
      tone: "warning",
      sections: [{
        body: todos.map((todo) => `- [ ] ${todo.replace(/\r?\n/gu, "\n  ")}`).join("\n"),
      }],
    });
  }
  return null;
}
