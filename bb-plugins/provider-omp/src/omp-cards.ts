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
const titles: Record<string, string> = {
  advisor: "Advisor",
  "async-result": "Background job completed",
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
  let tone: OmpCard["tone"] = "info";
  if (type.startsWith("irc:")) {
    const from = text(d?.from);
    const to = text(d?.to);
    const pool = text(d?.pool);
    const replyTo = text(d?.replyTo);
    const mode = text(d?.mode);
    title = pool
      ? `Pool ${pool}${to ? ` → ${to}` : ""}`
      : `IRC${from ? ` ${from}` : ""}${to ? ` → ${to}` : ""}`;
    const body = text(d?.message) ?? text(d?.body) ?? fallback;
    if (body) {
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
    for (const note of items(d?.notes)) {
      const body = text(note.note);
      if (!body) continue;
      const severity = text(note.severity) ?? "nit";
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
  } else if (type === "async-result") {
    for (const job of items(d?.jobs)) {
      const id = text(job.jobId);
      if (!id) continue;
      const status = text(job.status) ?? "completed";
      const jobTone = status === "failed" ? "error"
        : status === "cancelled" ? "warning"
        : status === "completed" ? "success" : "info";
      if (jobTone === "error" || (jobTone === "warning" && tone !== "error")) {
        tone = jobTone;
      }
      const warning = artifact(job.meta);
      sections.push({
        heading: text(job.label) ?? id,
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
  } else if (type === "launch-completion") {
    for (const daemon of items(d?.daemons)) {
      const name = text(daemon.name);
      if (!name) continue;
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
  } else if (type === "lsp-late-diagnostic") {
    for (const file of items(d?.files)) {
      const path = text(file.path);
      if (!path) continue;
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
  return boundOmpCard({ type, title, tone, sections });
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
