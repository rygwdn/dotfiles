import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const todoPhasesSchema = z.array(z.object({
  name: z.string(),
  tasks: z.array(z.object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "abandoned", "blocked"]),
    blocker: z.string().optional(),
  })),
}));

type TodoPhases = z.infer<typeof todoPhasesSchema>;
type PlanSteps = Extract<ThreadDelta, { kind: "item.close" }>["item"] & { type: "planSteps" };

const STEP_STATUSES = {
  pending: "pending",
  in_progress: "active",
  completed: "completed",
  abandoned: "failed",
  blocked: "pending",
} as const;

function stepText(value: string): string {
  const text = value.trim();
  let end = Math.min(text.length, 240);
  // Match bb's UTF-16 limit without splitting a valid surrogate pair.
  if (end < text.length && end > 0 &&
    text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
}

function planSteps(phases: TodoPhases): PlanSteps {
  const prefixPhase = phases.length > 1;
  return {
    type: "planSteps",
    steps: phases.flatMap((phase) => phase.tasks.map((task) => ({
      step: stepText(`${prefixPhase ? `${phase.name} · ` : ""}${task.content}${
        task.status === "blocked" && task.blocker ? ` (blocked: ${task.blocker})` : ""
      }`),
      status: STEP_STATUSES[task.status],
    }))),
  };
}

export interface OmpTodoCoordinator {
  refresh(canPublishInCurrentTurn?: () => boolean): Promise<void>;
  handleEvent(event: Record<string, unknown>): Promise<void>;
}

export function createOmpTodoCoordinator(options: {
  readState: () => Promise<{ todoPhases?: TodoPhases }>;
  publish: (deltas: readonly ThreadDelta[]) => void;
}): OmpTodoCoordinator {
  let phases: TodoPhases | undefined;
  let canonical: string | undefined;
  let published: string | undefined;
  let publishedNonEmpty = false;
  let active = false;

  function publish(publishInCurrentTurn = false): void {
    if ((!active && !publishInCurrentTurn) || phases === undefined || canonical === published) return;
    const item = planSteps(phases);
    const nonEmpty = item.steps.length > 0;
    // Empty snapshots only clear a plan that we previously displayed.
    if (!nonEmpty && !publishedNonEmpty) return;
    options.publish([{
      kind: "item.close",
      key: { channel: "planSteps" },
      status: "completed",
      item,
    }]);
    published = canonical;
    publishedNonEmpty = nonEmpty;
  }

  function observe(value: unknown, publishInCurrentTurn = false): boolean {
    const parsed = todoPhasesSchema.safeParse(value);
    if (!parsed.success) return false;
    phases = parsed.data;
    canonical = JSON.stringify(phases);
    publish(publishInCurrentTurn);
    return true;
  }

  async function refresh(canPublishInCurrentTurn?: () => boolean): Promise<void> {
    // A best-effort presentation refresh must not fail the user's tool or turn.
    try {
      const state = await options.readState();
      observe(state.todoPhases, canPublishInCurrentTurn?.() ?? false);
    } catch {
      // Keep the last canonical snapshot if the child exits during the request.
    }
  }

  return {
    refresh,
    async handleEvent(event) {
      if (event.type === "agent_start") {
        // planSteps is turn-scoped in bb. Seed on resume, publish once a turn opens.
        active = true;
        publish();
      } else if (event.type === "tool_execution_end") {
        const result = event.result as { details?: { phases?: unknown }; isError?: boolean } | undefined;
        if (event.toolName === "todo" && event.isError !== true && result?.isError !== true &&
          observe(result?.details?.phases)) return;
        // eval and extension tools can invoke todo without a top-level todo event.
        await refresh();
      } else if (event.type === "turn_end" || event.type === "agent_end") {
        await refresh();
        if (event.type === "agent_end" && event.deferSettlement !== true) active = false;
      }
      // todo_reminder contains only incomplete tasks, not the canonical list.
    },
  };
}
