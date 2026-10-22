import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  experimental_fileReadPresentation as fileReadPresentation,
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  experimental_REASONING_PRESENTATION as REASONING_PRESENTATION,
  experimental_searchPresentation as searchPresentation,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
  type DeltaItemShape,
  type DeltaPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";

export interface ClassifiedOmpTool {
  item: DeltaItemShape;
  presentation?: DeltaPresentation;
  deferred?: boolean;
}

const nonblank = z.string().refine((value) => value.trim().length > 0);
const readArgsSchema = z.object({ path: nonblank }).passthrough();
const searchArgsSchema = z.object({ path: nonblank.optional() }).passthrough();
const thinkArgsSchema = z.object({ thoughts: nonblank });
const webSearchArgsSchema = z.object({ query: nonblank });
const pathArgsSchema = z.object({ path: z.string() });
const objectArgsSchema = z.record(z.string(), z.unknown());
const searchArgSchemas = {
  grep: searchArgsSchema.extend({ pattern: nonblank }),
  ast_grep: searchArgsSchema.extend({ pat: nonblank }),
  find: searchArgsSchema.extend({ query: nonblank }),
};
const readResultSchema = z.object({
  details: z.object({
    kind: z.string().optional(),
    resolvedPath: nonblank.optional(),
    mediaPath: nonblank.optional(),
    isDirectory: z.boolean().optional(),
    url: nonblank.optional(),
    finalUrl: nonblank.optional(),
    displayReadTargets: z.array(z.string()).optional(),
    meta: z.object({ source: z.object({ type: z.string(), value: nonblank }).passthrough().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  content: z.array(z.unknown()).optional(),
  isError: z.boolean().optional(),
}).passthrough();
const imageSchema = z.object({
  type: z.literal("image"),
  data: z.string().trim().min(1),
  mimeType: z.string().regex(/^image\/[^\s/]+$/),
});
const deviceArgsSchema = z.object({ path: z.string(), content: z.string().optional().nullable() }).passthrough();
const deviceResultSchema = z.object({ details: z.object({ xdev: z.object({
  tool: nonblank,
  mode: z.enum(["help", "execute"]),
  args: z.record(z.string(), z.unknown()).optional(),
  inner: z.unknown().optional(),
}).passthrough() }).passthrough() }).passthrough();
const DEVICE_PATTERN = /^xd:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)$/i;
const DEVICE_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, find: true, ast_grep: true, web_search: true, think: true };

export function ompToolPresentation(
  classified: ClassifiedOmpTool,
  toolName: string,
  intent?: string,
): DeltaPresentation | undefined {
  if (!intent) return classified.presentation;
  const base = classified.presentation ?? toolPresentation(toolName);
  return {
    ...base,
    title: presentationTitle(intent),
    ...((base.detail || base.title) ? { detail: presentationDetail(base.detail ?? base.title ?? "") } : {}),
  };
}

function localPath(path: string | undefined, cwd?: string): string | undefined {
  if (!path || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;
  let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~" || normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  return isAbsolute(normalized) ? resolve(normalized)
    : cwd && isAbsolute(cwd) ? resolve(cwd, normalized) : undefined;
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value || (value.startsWith("www.") && value.length <= 4)) return undefined;
  const candidate = value.startsWith("www.") ? `https://${value}` : value.replace(/^https?:\/(?!\/)/i, (scheme) => `${scheme}/`);
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function classifyRead(args: unknown, result: unknown, ended: boolean, failed: boolean, cwd?: string): ClassifiedOmpTool {
  const generic: ClassifiedOmpTool = { item: { type: "tool", tool: "read", args } };
  const output = readResultSchema.safeParse(result);
  const details = output.success ? output.data.details : undefined;
  const parsed = readArgsSchema.safeParse(args === undefined && ended
    ? { path: details?.url ?? details?.finalUrl ?? details?.resolvedPath ?? details?.meta?.source?.value }
    : args);
  if (!parsed.success) return generic;
  if (!ended) return { ...generic, deferred: true };
  if (!output.success) return generic;
  if ((details?.displayReadTargets?.length ?? 0) > 1) return generic;
  const source = details?.meta?.source;
  const path = localPath(details?.resolvedPath ?? (source?.type === "path" ? source.value : undefined), cwd);
  if (details?.isDirectory === true) {
    if (!path) return generic;
    return {
      item: { type: "search", mode: "list", path, query: parsed.data.path },
      presentation: { icon: { glyph: "FolderOpen" }, label: { pending: "Listing directory", completed: "Listed directory" }, title: presentationTitle(path), detail: presentationDetail(parsed.data.path) },
    };
  }
  const url = httpUrl(details?.url) ??
    (details?.kind === "url" ? httpUrl(details.finalUrl) : undefined) ??
    httpUrl(parsed.data.path);
  if (url) return {
    item: { type: "webFetch", url, pattern: null },
    presentation: { ...webFetchPresentation(url), detail: presentationDetail(details?.finalUrl && details.finalUrl !== url ? `${parsed.data.path} → ${details.finalUrl}` : parsed.data.path) },
  };
  // Result bytes, not the extension, distinguish an image from a text response.
  // Without resolved metadata, only an unselected, single local invocation is safe.
  const imagePath = path ?? localPath(details?.mediaPath, cwd) ??
    (!/[:;\n]/.test(parsed.data.path) ? localPath(parsed.data.path, cwd) : undefined);
  if (!failed && !output.data.isError && imagePath && output.data.content?.some((block) => imageSchema.safeParse(block).success)) {
    return { item: { type: "imageView", path: imagePath } };
  }
  if (!path) return generic;
  return { item: { type: "fileRead", path }, presentation: { ...fileReadPresentation(path), detail: presentationDetail(parsed.data.path) } };
}

/** Returns null only for tool names handled by the translator's legacy classifier. */
export function classifyTypedOmpTool(
  toolName: string,
  args: unknown,
  options: { result?: unknown; ended?: boolean; failed?: boolean; cwd?: string } = {},
): ClassifiedOmpTool | null {
  const generic: ClassifiedOmpTool = { item: { type: "tool", tool: toolName, args } };
  const { result, ended = false, failed = false, cwd } = options;
  if (toolName === "write") {
    // Even malformed/unknown device dispatch must never be presented as a file edit.
    const device = deviceArgsSchema.safeParse(args);
    const path = device.success ? device.data.path : pathArgsSchema.safeParse(args).data?.path;
    if (!path || !/^xd:\/\//i.test(path.trim())) {
      return args === undefined && ended && deviceResultSchema.safeParse(result).success ? generic : null;
    }
    if (!ended) return { ...generic, deferred: true };
    if (!device.success || typeof device.data.content !== "string") return generic;
    const match = DEVICE_PATTERN.exec(path.trim());
    const dispatch = deviceResultSchema.safeParse(result);
    if (!match || !dispatch.success || dispatch.data.details.xdev.mode !== "execute" ||
      dispatch.data.details.xdev.tool !== match[1] || !DEVICE_TOOLS[match[1] ?? ""]) return generic;
    let parsedContent: unknown;
    try { parsedContent = JSON.parse(device.data.content); } catch { return generic; }
    if (!objectArgsSchema.safeParse(parsedContent).success) return generic;
    const innerArgs = dispatch.data.details.xdev.args ?? parsedContent;
    const inner = classifyTypedOmpTool(match[1]!, innerArgs, { result: dispatch.data.details.xdev.inner, ended: true, failed, cwd });
    return inner && inner.item.type !== "tool" ? inner : generic;
  }
  if (toolName === "read") return classifyRead(args, result, ended, failed, cwd);
  if (toolName === "think") {
    const parsed = thinkArgsSchema.safeParse(args);
    return parsed.success ? { item: { type: "reasoning", summary: [], content: [parsed.data.thoughts] }, presentation: REASONING_PRESENTATION } : generic;
  }
  if (toolName === "web_search") {
    const parsed = webSearchArgsSchema.safeParse(args);
    return parsed.success ? { item: { type: "webSearch", queries: [parsed.data.query] }, presentation: webSearchPresentation(parsed.data.query) } : generic;
  }
  if (toolName === "glob") {
    const parsed = searchArgsSchema.safeParse(args);
    if (!parsed.success) return generic;
    const query = parsed.data.path ?? ".";
    return { item: { type: "search", mode: "path", query }, presentation: searchPresentation({ mode: "path", query }) };
  }
  if (toolName === "grep" || toolName === "ast_grep" || toolName === "find") {
    const field = toolName === "grep" ? "pattern" : toolName === "ast_grep" ? "pat" : "query";
    const parsed = searchArgSchemas[toolName].safeParse(args);
    if (!parsed.success) return generic;
    const query = parsed.data[field] as string;
    const mode = toolName === "find" ? "path" : "content";
    return { item: { type: "search", mode, query, ...(parsed.data.path ? { path: parsed.data.path } : {}) }, presentation: searchPresentation({ mode, query }) };
  }
  return null;
}
