import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface OmpFileLinkRoots {
  artifactsDir?: string;
  localDir?: string;
}

const SCAN_TTL_MS = 1_000;
const MAX_CACHED_ROOTS = 32;
const MAX_AGENT_DEPTH = 4;
const MAX_AGENT_DIRECTORIES = 128;
const MAX_AGENT_ENTRIES = 8_192;

interface RootScan {
  expiresAt: number;
  entries: Dirent[];
  artifacts: Map<string, string>;
  agents?: Map<string, string>;
}

const rootScans = new Map<string, RootScan>();

function scanRoot(root: string): RootScan | undefined {
  const cached = rootScans.get(root);
  if (cached && cached.expiresAt > Date.now()) return cached;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const artifacts = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const id = /^(\d+)\./.exec(entry.name)?.[1];
    if (id !== undefined && !artifacts.has(id)) artifacts.set(id, entry.name);
  }
  const scan = { entries, artifacts, expiresAt: Date.now() + SCAN_TTL_MS };
  rootScans.delete(root);
  rootScans.set(root, scan);
  while (rootScans.size > MAX_CACHED_ROOTS) {
    rootScans.delete(rootScans.keys().next().value!);
  }
  return scan;
}

function scanAgents(root: string, scan: RootScan): Map<string, string> {
  if (scan.agents) return scan.agents;
  const agents = new Map<string, string>();
  const queue = [{ directory: "", entries: scan.entries, depth: 0 }];
  let visitedEntries = 0;
  let visitedDirectories = 0;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (++visitedDirectories > MAX_AGENT_DIRECTORIES) break;
    let entries = current.entries;
    if (index > 0) {
      try {
        entries = readdirSync(resolve(root, current.directory), { withFileTypes: true });
      } catch {
        continue;
      }
    }
    for (const entry of entries) {
      if (++visitedEntries > MAX_AGENT_ENTRIES) break;
      const path = current.directory ? `${current.directory}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const id = entry.name.slice(0, -3);
        if (!agents.has(id)) agents.set(id, path);
      } else if (entry.isDirectory() && current.depth < MAX_AGENT_DEPTH &&
        queue.length < MAX_AGENT_DIRECTORIES) {
        // Never follow directory symlinks: they can leave the root or cycle.
        queue.push({ directory: path, entries: [], depth: current.depth + 1 });
      }
    }
    if (visitedEntries > MAX_AGENT_ENTRIES) break;
  }
  scan.agents = agents;
  return agents;
}

function isWithin(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function existingFile(root: string, path: string): string | undefined {
  const target = resolve(root, path);
  if (!isWithin(root, target)) return undefined;
  try {
    if (!isWithin(realpathSync(root), realpathSync(target)) || !statSync(target).isFile()) {
      return undefined;
    }
    return target;
  } catch {
    return undefined;
  }
}

function decodePath(path: string): string | undefined {
  try {
    const decoded = decodeURIComponent(path).replaceAll("\\", "/");
    if (isAbsolute(decoded) || /^[a-z]:\//i.test(decoded) ||
      /[\u0000-\u001f\u007f]/.test(decoded) || decoded.split("/").includes("..")) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

interface ResolvedOmpFile {
  path: string;
  lineRange?: { start: number; end?: number };
}

function resolveOmpUrl(url: string, roots: OmpFileLinkRoots): ResolvedOmpFile | undefined {
  const match = /^(local|artifact|agent):\/\/(.*)$/is.exec(url);
  if (!match) return undefined;
  // Selectors and extraction queries describe a view, not part of the filename.
  // Strip them before decoding so an encoded colon remains a literal filename.
  const selectedPath = match[2].split(/[?#]/, 1)[0];
  const selectors = /(?::(?:raw|img|conflicts|(?:\d+(?:[-+]\d*)?|-\d+)(?:,(?:\d+(?:-\d*)?|-\d+))*))+$/i.exec(selectedPath);
  const path = selectors ? selectedPath.slice(0, selectors.index) : selectedPath;
  const selection = selectors && /:(\d+)(?:([-+])(\d*))?(?=[:,]|$)/.exec(selectors[0]);
  const start = selection ? Number(selection[1]) : 0;
  const selectedEnd = selection?.[3] ? Number(selection[3]) : undefined;
  const end = selectedEnd === undefined ? undefined
    : selection?.[2] === "+" ? start + selectedEnd - 1 : selectedEnd;
  const lineRange = Number.isSafeInteger(start) && start > 0 &&
    (end === undefined || (Number.isSafeInteger(end) && end >= start))
    ? { start, ...(end === undefined ? {} : { end }) } : undefined;
  const scheme = match[1].toLowerCase();
  const decoded = decodePath(scheme === "local" ? path.replace(/^\/(?!\/)/, "") : path);
  if (!decoded) return undefined;
  const root = scheme === "local" ? roots.localDir : roots.artifactsDir;
  if (!root || !isAbsolute(root)) return undefined;
  if (scheme === "local") {
    const file = existingFile(root, decoded);
    return file ? { path: file, lineRange } : undefined;
  }
  const scan = scanRoot(root);
  if (!scan) return undefined;
  const relativePath = scheme === "artifact"
    ? (/^\d+$/.test(decoded) ? scan.artifacts.get(decoded) : undefined)
    : scanAgents(root, scan).get(decoded.split("/", 1)[0]);
  const file = relativePath === undefined ? undefined : existingFile(root, relativePath);
  return file ? { path: file, lineRange } : undefined;
}

function fileHref(file: ResolvedOmpFile): string | undefined {
  // bb decodes before parsing fragments, queries, and line suffixes, and
  // requires a likely file basename for absolute Markdown hrefs.
  const name = file.path.split(sep).at(-1) ?? "";
  if (/[?#]/.test(file.path) || /:\d+(?:-\d+|:\d+)?$/.test(file.path) ||
    !name.includes(".")) return undefined;
  try {
    const path = file.path.split(sep).map((segment) => encodeURIComponent(segment).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )).join("/");
    const line = file.lineRange;
    return path + (line ? `#L${line.start}${line.end === undefined ? "" : `-L${line.end}`}` : "");
  } catch {
    return undefined;
  }
}

function codeSpanEnd(text: string, start: number, delimiter: string): number | undefined {
  let index = start + delimiter.length;
  while ((index = text.indexOf(delimiter, index)) !== -1) {
    const end = index + delimiter.length;
    if (text[index - 1] !== "`" && text[end] !== "`") return end;
    index = end;
  }
  return undefined;
}

interface Destination {
  start: number;
  end: number;
  after: number;
}

function readDestination(text: string, index: number): Destination | undefined {
  while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  if (text[index] === "<") {
    const end = text.indexOf(">", index + 1);
    return end === -1 ? undefined : { start: index + 1, end, after: end + 1 };
  }
  const start = index;
  let depth = 0;
  while (index < text.length && !/\s/.test(text[index])) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "(") depth++;
    if (text[index] === ")" && depth-- === 0) break;
    index++;
  }
  return depth > 0 ? undefined : { start, end: index, after: index };
}

function markdownLink(text: string, start: number): (Destination & { linkEnd: number }) | undefined {
  let index = start + 1;
  let depth = 1;
  for (; index < text.length; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === "`") {
      const delimiter = /^`+/.exec(text.slice(index))![0];
      const end = codeSpanEnd(text, index, delimiter);
      if (end !== undefined) { index = end - 1; continue; }
    }
    if (text[index] === "[") depth++;
    if (text[index] === "]" && --depth === 0) break;
  }
  if (text[index + 1] === ":" &&
    /^[\t >]*$/.test(text.slice(text.lastIndexOf("\n", start - 1) + 1, start))) {
    const destination = readDestination(text, index + 2);
    if (!destination) return undefined;
    const lineEnd = text.indexOf("\n", destination.after);
    return { ...destination, linkEnd: lineEnd === -1 ? text.length : lineEnd };
  }
  if (text[index + 1] !== "(") return undefined;
  const destination = readDestination(text, index + 2);
  if (!destination) return undefined;
  index = destination.after;
  while (index < text.length && /\s/.test(text[index])) index++;
  if (text[index] === "\"" || text[index] === "'" || text[index] === "(") {
    const close = text[index] === "(" ? ")" : text[index];
    for (index++; index < text.length && text[index] !== close; index++) {
      if (text[index] === "\\") index++;
    }
    index++;
    while (index < text.length && /\s/.test(text[index])) index++;
  }
  return text[index] === ")" ? { ...destination, linkEnd: index + 1 } : undefined;
}

function bareUrlEnd(text: string, start: number): number {
  let end = start;
  let parentheses = 0;
  while (end < text.length && !/[\s<>`"'\[\]{}]/.test(text[end])) {
    if (/[;,]/.test(text[end]) && /^(?:local|artifact|agent):\/\//i.test(text.slice(end + 1))) break;
    if (text[end] === "(") parentheses++;
    if (text[end] === ")") {
      if (parentheses === 0) break;
      parentheses--;
    }
    end++;
  }
  while (end > start && /[.,;:!?*\u2026]/.test(text[end - 1])) end--;
  return end;
}

function rewriteInline(text: string, hrefFor: (url: string) => string | undefined): string {
  const tokens = /`+|!?\[|<(?=(?:local|artifact|agent):\/\/)|(?:local|artifact|agent):\/\//gi;
  const parts: string[] = [];
  let copied = 0;
  for (const token of text.matchAll(tokens)) {
    const start = token.index;
    if (start < copied || (start > 0 && text[start - 1] === "\\")) continue;
    let end: number;
    let replacement: string | undefined;
    if (token[0][0] === "`") {
      const closing = codeSpanEnd(text, start, token[0]);
      if (closing === undefined) continue;
      end = closing;
      const href = hrefFor(text.slice(start + token[0].length, end - token[0].length).trim());
      if (href) replacement = `[${text.slice(start, end)}](${href})`;
    } else if (token[0].endsWith("[")) {
      const image = token[0][0] === "!";
      const link = markdownLink(text, start + (image ? 1 : 0));
      if (!link) continue;
      end = link.linkEnd;
      const href = image ? undefined : hrefFor(text.slice(link.start, link.end));
      if (href) replacement = `${text.slice(start, link.start)}${href}${text.slice(link.end, end)}`;
    } else {
      if (start > 0 && /[\w+./:-]/.test(text[start - 1])) continue;
      const angled = token[0] === "<";
      const urlStart = start + (angled ? 1 : 0);
      const urlEnd = angled ? text.indexOf(">", urlStart) : bareUrlEnd(text, urlStart);
      if (urlEnd === -1) continue;
      end = urlEnd + (angled ? 1 : 0);
      const url = text.slice(urlStart, urlEnd);
      const href = hrefFor(url);
      if (href) replacement = `[${url.replace(/[\\[\]]/g, "\\$&")}](${href})`;
    }
    // Advance over existing links and code even when their URLs cannot resolve.
    // They must not acquire nested links from subsequent token matches.
    parts.push(text.slice(copied, start), replacement ?? text.slice(start, end));
    copied = end;
  }
  return copied === 0 ? text : parts.join("") + text.slice(copied);
}

/** Translate only display text; callers must retain the original omp messages. */
export function rewriteOmpFileLinks(text: string, roots?: OmpFileLinkRoots): string {
  if (!roots || !(roots.artifactsDir || roots.localDir) || !/(?:local|artifact|agent):\/\//i.test(text)) {
    return text;
  }
  const hrefs = new Map<string, string | undefined>();
  const hrefFor = (url: string): string | undefined => {
    if (!hrefs.has(url)) {
      const file = resolveOmpUrl(url, roots);
      hrefs.set(url, file === undefined ? undefined : fileHref(file));
    }
    return hrefs.get(url);
  };
  const parts: string[] = [];
  let fence: { character: string; length: number } | undefined;
  let copied = 0;
  let normalStart = 0;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const marker = /^[\t ]*(?:>[\t ]*)*(?:[-+*][\t ]+|\d+[.)][\t ]+)?(`{3,}|~{3,})([^\r\n]*)/.exec(line[0]);
    if (!marker) continue;
    const end = line.index + line[0].length;
    if (fence) {
      if (marker[1][0] !== fence.character || marker[1].length < fence.length || marker[2].trim()) continue;
      parts.push(text.slice(copied, end));
      copied = end;
      normalStart = end;
      fence = undefined;
    } else if (marker[1][0] !== "`" || !marker[2].includes("`")) {
      parts.push(rewriteInline(text.slice(normalStart, line.index), hrefFor));
      copied = line.index;
      fence = { character: marker[1][0], length: marker[1].length };
    }
  }
  parts.push(fence ? text.slice(copied) : rewriteInline(text.slice(normalStart), hrefFor));
  return parts.join("");
}
