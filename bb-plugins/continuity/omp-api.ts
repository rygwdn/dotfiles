import type { z } from "zod";
import type { ContextMessage, JournalEntry } from "./policy";

// Structural subset of OMP 18.12's public extension API, verified against its source.
export interface OmpContext {
  cwd: string;
  agent: { kind: "main" | "sub" };
  sessionManager: { getSessionId(): string; getBranch(): JournalEntry[] };
  getContextUsage(): { tokens: number; contextWindow: number; percent: number } | undefined;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getAsyncJobSnapshot(): { running: unknown[]; delivery: { queued: number; delivering: boolean; pendingJobIds: string[] } } | null;
  setInterval(callback: () => void | Promise<void>, ms: number): unknown;
  clearTimer(timer: unknown): void;
  compact(options: { mode: "soft"; suppressContinuation: boolean; onComplete: () => void; onError: (error: Error) => void }): Promise<void>;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
export interface OmpEvents {
  session_start: {}; session_switch: {}; session_branch: {}; session_tree: {}; session_shutdown: {};
  input: {}; agent_start: {}; agent_end: { willContinue?: boolean; awaitingAsyncWork?: boolean };
  context: { messages: ContextMessage[] };
  session_compact: { compactionEntry: { id: string; timestamp: string }; fromExtension: boolean };
  "session.compacting": {}; cache_warming_decision: {};
}
export interface OmpApi {
  zod: typeof z;
  pi: { settings: unknown };
  getActiveTools(): string[];
  appendEntry<T>(customType: string, data: T): void;
  on<K extends keyof OmpEvents>(name: K, callback: (event: OmpEvents[K], ctx: OmpContext) => unknown | Promise<unknown>): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: OmpContext): Promise<void> }): void;
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown; approval: "read";
    execute(id: string, params: { id: string; offset: number; limit: number }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: OmpContext): Promise<unknown>;
  }): void;
}
