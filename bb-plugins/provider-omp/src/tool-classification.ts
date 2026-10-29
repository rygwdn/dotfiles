import { z } from "zod";
import {
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  experimental_REASONING_PRESENTATION as REASONING_PRESENTATION,
  experimental_toolPresentation as toolPresentation,
  type DeltaItemShape,
  type DeltaPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";

export interface ClassifiedOmpTool {
  item: DeltaItemShape;
  presentation?: DeltaPresentation;
}

const nonblank = z.string().refine((value) => value.trim().length > 0);
const thinkArgsSchema = z.object({ thoughts: nonblank });
const programIntentFields = { i: z.string().nullish(), title: z.string().nullish() };
const evalArgsSchema = z.object({ language: z.enum(["py", "js"]), code: nonblank, ...programIntentFields });
const gatewaySearchArgsSchema = z.object({ query: nonblank, ...programIntentFields });
const gatewayExecuteArgsSchema = z.object({ code: nonblank, ...programIntentFields });
const PROGRAM_PREVIEW_LENGTH = 160;
const GENERIC_PROGRAM_INTENT = /^(?:(?:run|running|ran|execute|executing|executed|evaluate|evaluating|evaluated)\s+)?(?:eval|python|javascript|js|py|typescript|ts|code|cell|script|program|tool gateway(?: code)?(?: execute| program)?|tool_gateway_code_execute)(?:\s+(?:eval|code|cell|script|program))?$/i;
const GENERIC_SIGNATURE_INTENT = /^(?:(?:run|running|ran|search|searching|searched|find|finding|found|discover|discovering|discovered|look up|looking up)\s+)?(?:tool gateway(?: code)?(?: search| signatures?)?|tool_gateway_code_search|signatures?)$/i;

function usefulProgramIntent(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\s+/g, " ").replace(/[.!:]+$/, "");
  return !GENERIC_PROGRAM_INTENT.test(normalized) && !GENERIC_SIGNATURE_INTENT.test(normalized)
    ? trimmed : undefined;
}

function programPresentation(toolName: string, args: unknown): DeltaPresentation | undefined {
  let source: string;
  let intent: { i?: string | null; title?: string | null };
  let label: DeltaPresentation["label"];
  if (toolName === "eval") {
    const parsed = evalArgsSchema.safeParse(args);
    if (!parsed.success) return undefined;
    source = parsed.data.code;
    intent = parsed.data;
    const language = parsed.data.language === "py" ? "Python" : "JavaScript";
    label = { pending: `Running ${language}`, completed: `Ran ${language}` };
  } else if (toolName === "tool_gateway_code_search") {
    const parsed = gatewaySearchArgsSchema.safeParse(args);
    if (!parsed.success) return undefined;
    source = parsed.data.query;
    intent = parsed.data;
    label = { pending: "Discovering Tool Gateway signatures", completed: "Discovered Tool Gateway signatures" };
  } else {
    const parsed = gatewayExecuteArgsSchema.safeParse(args);
    if (!parsed.success) return undefined;
    source = parsed.data.code;
    intent = parsed.data;
    label = { pending: "Running Tool Gateway program", completed: "Ran Tool Gateway program" };
  }
  const singleLine = source.trim().replace(/\s+/g, " ");
  const preview = singleLine.length > PROGRAM_PREVIEW_LENGTH
    ? `${singleLine.slice(0, PROGRAM_PREVIEW_LENGTH - 1)}…` : singleLine;
  return {
    icon: { glyph: toolName === "tool_gateway_code_search" ? "Search" : "Code" },
    label,
    title: presentationTitle(usefulProgramIntent(intent.i) ?? usefulProgramIntent(intent.title) ?? preview),
    detail: presentationDetail(preview),
  };
}

export function ompToolPresentation(
  classified: ClassifiedOmpTool,
  toolName: string,
  intent?: string,
): DeltaPresentation | undefined {
  if (!intent || (
    classified.presentation &&
    (toolName === "eval" || toolName === "tool_gateway_code_search" || toolName === "tool_gateway_code_execute") &&
    !usefulProgramIntent(intent)
  )) {
    return classified.presentation;
  }
  const base = classified.presentation ?? toolPresentation(toolName);
  return {
    ...base,
    title: presentationTitle(intent),
    ...((base.detail || base.title) ? { detail: presentationDetail(base.detail ?? base.title ?? "") } : {}),
  };
}

/** Returns null only for tool names handled by the translator's legacy classifier. */
export function classifyTypedOmpTool(
  toolName: string,
  args: unknown,
): ClassifiedOmpTool | null {
  const generic: ClassifiedOmpTool = { item: { type: "tool", tool: toolName, args } };
  if (toolName === "eval" || toolName === "tool_gateway_code_search" || toolName === "tool_gateway_code_execute") {
    const presentation = programPresentation(toolName, args);
    return presentation ? { ...generic, presentation } : generic;
  }
  if (
    toolName === "read" || toolName === "grep" || toolName === "glob" ||
    toolName === "find" || toolName === "ast_grep" || toolName === "web_search" ||
    toolName === "write" || toolName === "edit"
  ) {
    return generic;
  }
  if (toolName === "think") {
    const parsed = thinkArgsSchema.safeParse(args);
    return parsed.success ? { item: { type: "reasoning", summary: [], content: [parsed.data.thoughts] }, presentation: REASONING_PRESENTATION } : generic;
  }
  return null;
}
