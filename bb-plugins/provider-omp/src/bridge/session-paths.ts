import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const OMP_BRIDGE_SESSION_DIR_ENV = "BB_OMP_BRIDGE_SESSION_DIR";
const sessionRecordSchema = z.record(z.string(), z.unknown());

interface ResolveOmpBridgeSessionDirArgs {
  env: NodeJS.ProcessEnv;
}

interface ResolveOmpThreadSessionDirArgs extends ResolveOmpBridgeSessionDirArgs {
  threadId: string;
}

export function resolveOmpBridgeSessionDir(
  args: ResolveOmpBridgeSessionDirArgs,
): string {
  const configuredSessionDir = args.env[OMP_BRIDGE_SESSION_DIR_ENV]?.trim();
  if (configuredSessionDir) {
    return resolve(configuredSessionDir);
  }

  return join(homedir(), ".bb", "omp-bridge-sessions");
}

export function resolveOmpThreadSessionDir(
  args: ResolveOmpThreadSessionDirArgs,
): string {
  return join(
    resolveOmpBridgeSessionDir({ env: args.env }),
    sanitizeSessionKey(args.threadId),
  );
}

/** Match OMP's --continue selection without treating empty draft sessions as history. */
export function findNewestOmpSessionFile(
  sessionDir: string,
): string | undefined {
  let files;
  try {
    files = readdirSync(sessionDir, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  const sessions = files.flatMap((file) => {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) return [];
    const path = join(sessionDir, file.name);
    const stat = statSync(path);
    if (stat.size === 0) return [];
    const records: Record<string, unknown>[] = [];
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(sessionRecordSchema.parse(JSON.parse(line)));
      } catch {
        // OMP's session listing also tolerates an incomplete trailing record.
      }
    }
    const titleRecord = records[0]?.type === "title" ? records[0] : undefined;
    const header = records[titleRecord === undefined ? 0 : 1];
    if (
      header?.type !== "session" ||
      typeof header.id !== "string" ||
      header.id.length === 0
    ) {
      return [];
    }
    const title = titleRecord === undefined ? header.title : titleRecord.title;
    const nonempty =
      hasDisplayText(title) ||
      records.some((record) => {
        if (record.type === "compaction") {
          return hasDisplayText(record.shortSummary);
        }
        if (
          record.type !== "message" ||
          record.message === null ||
          typeof record.message !== "object" ||
          !("role" in record.message)
        ) {
          return false;
        }
        const message = record.message;
        if (message.role === "assistant" || message.role === "toolResult") {
          return true;
        }
        if (message.role !== "user" && message.role !== "developer") return false;
        if (!("content" in message)) return false;
        return (
          hasDisplayText(message.content) ||
          (Array.isArray(message.content) &&
            message.content.some(
              (block: unknown) =>
                block !== null &&
                typeof block === "object" &&
                "text" in block &&
                hasDisplayText(block.text),
            ))
        );
      });
    if (!nonempty) return [];
    const created =
      typeof header.timestamp === "string" ? Date.parse(header.timestamp) : 0;
    return [{
      path,
      modified: stat.mtimeMs,
      created: Number.isFinite(created) ? created : 0,
    }];
  });
  sessions.sort(
    (a, b) =>
      b.modified - a.modified ||
      b.created - a.created ||
      b.path.localeCompare(a.path),
  );
  return sessions[0]?.path;
}

function hasDisplayText(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.split(/\r?\n/, 1)[0] ?? "")
      .replace(/[\x00-\x1F\x7F]/g, "")
      .trim().length > 0
  );
}

function sanitizeSessionKey(threadId: string): string {
  const key = threadId.replace(/[^A-Za-z0-9._-]/g, "_");
  return key === "" || key === "." || key === ".." ? "_" : key;
}
