import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
// The package's UMD `main` uses runtime relative requires that bb's server bundle cannot resolve.
import { parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Resolve even the defaults on the host: static roots cannot be removed when
// a profile, an agent-dir override, or a skills setting disables them.
export const OMP_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_resolvesNativeRoots: true,
};

const ompSettingsSchema = z.object({
  skills: z
    .object({
      enabled: z.boolean().optional(),
      enablePiUser: z.boolean().optional(),
      enablePiProject: z.boolean().optional(),
      enableAgentsUser: z.boolean().optional(),
      enableAgentsProject: z.boolean().optional(),
      enableClaudeUser: z.boolean().optional(),
      enableClaudeProject: z.boolean().optional(),
      enableCodexUser: z.boolean().optional(),
      customDirectories: z.array(z.string()).optional(),
    })
    .optional(),
  enabledProviders: z.array(z.string()).optional(),
  disabledProviders: z.array(z.string()).optional(),
  // Lenient: a malformed role map must not discard the rest of the settings.
  modelRoles: z.record(z.string(), z.unknown()).optional().catch(undefined),
  modelPresets: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

// skillshare/manifest.ts validates lock ids and versions before deriving paths.
const skillLockSchema = z.object({
  version: z.literal(1),
  skills: z
    .record(
      z.string().regex(/^@[a-z0-9][a-z0-9_]{2,31}\/[a-z0-9]+(?:-[a-z0-9]+)*$/u),
      z.object({
        version: z
          .string()
          .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u)
          .refine((version) => !version.includes("..")),
        integrity: z.string().min(1),
        resolved: z.string(),
      }),
    )
    .default({}),
});

type OmpSettings = z.infer<typeof ompSettingsSchema>;
type SkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

export interface ResolveOmpNativeRootsArgs {
  homeDir: string;
  cwd: string | null;
  env: Readonly<Record<string, string | undefined>>;
}

// Mirrors pi-utils/src/dirs.ts in OMP 18.10.4. The retained PI_* variables
// are upstream names, not aliases for guessed OMP_* replacements.
function normalizeProfileName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || name === "default") return undefined;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name) ||
    name.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu.test(name)
  ) {
    throw new Error(`Invalid OMP profile "${value}"`);
  }
  return name;
}

function resolveOmpAgentDir(
  args: ResolveOmpNativeRootsArgs,
  cwd: string,
): string {
  const configRoot = path.join(args.homeDir, args.env.PI_CONFIG_DIR || ".omp");
  const profile = normalizeProfileName(
    args.env.OMP_PROFILE !== undefined
      ? args.env.OMP_PROFILE
      : args.env.PI_PROFILE,
  );
  if (profile) return path.join(configRoot, "profiles", profile, "agent");

  let inheritedProfile: string | undefined;
  try {
    inheritedProfile = normalizeProfileName(args.env.PI_PROFILE);
  } catch {
    inheritedProfile = undefined;
  }
  const override = args.env.PI_CODING_AGENT_DIR;
  const inheritedAgentDir = inheritedProfile
    ? path.join(configRoot, "profiles", inheritedProfile, "agent")
    : undefined;
  return override && override !== inheritedAgentDir
    ? path.resolve(cwd, override)
    : path.join(configRoot, "agent");
}

function expandTilde(homeDir: string, value: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return homeDir + value.slice(1);
  }
  return value.startsWith("~") ? path.join(homeDir, value.slice(1)) : value;
}

async function readSettings(
  filePath: string,
  format: "yaml" | "json" | "jsonc",
): Promise<OmpSettings | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const errors: ParseError[] = [];
    const raw: unknown =
      format === "yaml"
        ? parseYaml(content)
        : format === "jsonc"
          ? parseJsonc(content, errors, { allowTrailingComma: true })
          : JSON.parse(content);
    if (errors.length > 0) return {};
    const parsed = ompSettingsSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function mergeSettings(
  base: OmpSettings,
  overlay: OmpSettings | null,
): OmpSettings {
  return {
    ...base,
    ...overlay,
    skills: { ...base.skills, ...overlay?.skills },
    modelRoles: { ...base.modelRoles, ...overlay?.modelRoles },
    // Same-name presets come whole from the highest layer; OMP never deep-merges them.
    modelPresets: { ...base.modelPresets, ...overlay?.modelPresets },
  };
}

export type OmpConfigLayer = "global" | "project" | "overlay";

async function loadSettingsLayers(
  args: ResolveOmpNativeRootsArgs,
  agentDir: string,
  cwd: string,
): Promise<{ source: OmpConfigLayer; settings: OmpSettings | null }[]> {
  // Main YAML is authoritative; legacy JSON is only migrated when both YAML
  // filenames are absent. Project config is cwd-only, unlike skill discovery.
  const layers: { source: OmpConfigLayer; settings: OmpSettings | null }[] = [
    {
      source: "global",
      settings:
        (await readSettings(path.join(agentDir, "config.yml"), "yaml")) ??
        (await readSettings(path.join(agentDir, "config.yaml"), "yaml")) ??
        (await readSettings(path.join(agentDir, "settings.json"), "jsonc")),
    },
  ];
  if (args.cwd !== null && cwd !== path.resolve(args.homeDir)) {
    layers.push(
      { source: "project", settings: withoutProjectNulls(await readSettings(path.join(cwd, ".omp", "settings.json"), "json")) },
      { source: "project", settings: withoutProjectNulls(await readSettings(path.join(cwd, ".omp", "config.yml"), "yaml")) },
    );
  }
  for (const file of args.env.PI_CONFIG_FILES?.split(path.delimiter) ?? []) {
    if (!file) continue;
    layers.push({
      source: "overlay",
      settings: await readSettings(path.resolve(cwd, expandTilde(args.homeDir, file)), "yaml"),
    });
  }
  return layers;
}

// OMP treats a project-layer null role or preset as unset (falls back to global);
// only overlay and runtime nulls suppress lower layers.
function withoutProjectNulls(settings: OmpSettings | null): OmpSettings | null {
  if (!settings) return settings;
  const result = { ...settings };
  for (const key of ["modelRoles", "modelPresets"] as const) {
    const record = settings[key];
    if (record) result[key] = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null));
  }
  return result;
}

async function loadSettings(
  args: ResolveOmpNativeRootsArgs,
  agentDir: string,
  cwd: string,
): Promise<OmpSettings> {
  let settings: OmpSettings = {};
  for (const layer of await loadSettingsLayers(args, agentDir, cwd)) {
    settings = mergeSettings(settings, layer.settings);
  }
  return settings;
}

async function projectAncestorDirs(
  cwd: string,
  homeDir: string,
): Promise<string[]> {
  const dirs: string[] = [];
  let current = cwd;
  let foundRepo = false;
  while (true) {
    dirs.push(current);
    try {
      // Worktrees use a .git file, not a directory.
      await lstat(path.join(current, ".git"));
      foundRepo = true;
      break;
    } catch {
      // No repository entry at this ancestor.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const home = path.resolve(homeDir);
  const homeIndex = dirs.indexOf(home);
  return !foundRepo && homeIndex !== -1 ? dirs.slice(0, homeIndex + 1) : dirs;
}

async function lockedSkillRoots(
  lockPath: string,
  agentDir: string,
  origin: "user" | "project",
): Promise<SkillRoot[]> {
  let lock: z.infer<typeof skillLockSchema>;
  try {
    lock = skillLockSchema.parse(JSON.parse(await readFile(lockPath, "utf8")));
  } catch {
    return [];
  }
  const roots: SkillRoot[] = [];
  for (const id of Object.keys(lock.skills).sort()) {
    const entry = lock.skills[id]!;
    const slash = id.indexOf("/");
    const name = id.slice(slash + 1);
    const storeDir = path.join(
      path.dirname(agentDir),
      "skillshare",
      id.slice(0, slash),
      name,
      entry.version,
    );
    try {
      const integrity = await readFile(
        path.join(storeDir, ".skillshare-integrity"),
        "utf8",
      );
      if (integrity.trim() !== entry.integrity) continue;
      const canonicalDir = await realpath(storeDir);
      const skillPath = path.join(canonicalDir, "SKILL.md");
      if (!(await stat(skillPath)).isFile()) continue;
      roots.push({
        path: skillPath,
        origin,
        recursive: false,
        shape: "skill-file",
        fallbackName: name,
      });
    } catch {
      // Missing or incomplete installs are restored by `omp skill update`.
    }
  }
  return roots;
}

/**
 * Effective `skills.customDirectories` as OMP resolves them for a session in `cwd`.
 * A `--config` overlay replaces arrays wholesale, so callers adding directories must
 * start from this list to keep the user's own.
 */
export async function resolveOmpCustomSkillDirectories(
  args: ResolveOmpNativeRootsArgs,
): Promise<string[]> {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const settings = await loadSettings(args, resolveOmpAgentDir(args, cwd), cwd);
  return (settings.skills?.customDirectories ?? [])
    .filter((dir) => dir !== "")
    .map((dir) => path.resolve(cwd, expandTilde(args.homeDir, dir)));
}

/** Effective `modelRoles` values (e.g. `anthropic/claude-opus-5-5:high`) for a session in `cwd`. */
export async function resolveOmpModelRoles(
  args: ResolveOmpNativeRootsArgs,
): Promise<string[]> {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const settings = await loadSettings(args, resolveOmpAgentDir(args, cwd), cwd);
  return Object.values(settings.modelRoles ?? {}).filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
}

/** The global OMP config file for `args`' profile: existing `config.yml`, else `config.yaml`, else `config.yml`. */
export async function resolveOmpGlobalConfigPath(
  args: ResolveOmpNativeRootsArgs,
): Promise<string> {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const agentDir = resolveOmpAgentDir(args, cwd);
  const yml = path.join(agentDir, "config.yml");
  const yaml = path.join(agentDir, "config.yaml");
  for (const file of [yml, yaml]) {
    try {
      await stat(file);
      return file;
    } catch {
      // Try the next filename.
    }
  }
  return yml;
}

/** A named OMP `modelPresets` entry: a whole role map plus an optional default thinking level. */
export interface OmpModelPreset {
  name: string;
  modelRoles: Record<string, string>;
  defaultThinkingLevel?: string;
  /** The config layer that owns the name (the highest one defining it). */
  source: OmpConfigLayer;
}

// OMP's preset-name rule (config/model-presets.ts, PRESET_NAME_PATTERN).
export const OMP_MODEL_PRESET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/u;

// OMP's preset thinking values: `auto` or a thinking effort (pi-catalog THINKING_EFFORTS); not `off`.
const OMP_PRESET_THINKING_LEVELS: Record<string, true> = {
  auto: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
};
// Selector suffixes OMP recognizes (`provider/id:level`).
const OMP_SELECTOR_THINKING_LEVELS: Record<string, true> = { ...OMP_PRESET_THINKING_LEVELS, off: true };

// OMP's modelRoleValueFromUnknown: a string, or a list of strings joined with commas.
function roleValueFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value.join(",");
}

// Mirrors OMP's parseModelPreset: hand-edited entries can hold anything; skip invalid ones.
function parseModelPreset(raw: unknown): Omit<OmpModelPreset, "name" | "source"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const roles = record.modelRoles;
  if (typeof roles !== "object" || roles === null || Array.isArray(roles)) return null;
  const modelRoles: Record<string, string> = {};
  for (const [role, value] of Object.entries(roles)) {
    if (typeof value !== "string" || value.trim() === "") return null;
    modelRoles[role] = value;
  }
  const level = record.defaultThinkingLevel;
  if (level === undefined) return { modelRoles };
  return typeof level === "string" && Object.hasOwn(OMP_PRESET_THINKING_LEVELS, level)
    ? { modelRoles, defaultThinkingLevel: level }
    : null;
}

/** Split `provider/model-id[:level]`; model ids may contain colons, so only a known trailing level is a suffix. */
export function splitOmpSelectorThinking(selector: string): { selector: string; thinking?: string } {
  const index = selector.lastIndexOf(":");
  const suffix = index > 0 ? selector.slice(index + 1) : "";
  return Object.hasOwn(OMP_SELECTOR_THINKING_LEVELS, suffix)
    ? { selector: selector.slice(0, index), thinking: suffix }
    : { selector };
}

/**
 * The model candidates (in OMP's order) for a preset's `default` role, following
 * `@role` aliases through the preset's own roles (applying a preset clears the roles
 * it omits) and splitting comma lists. Each carries its own thinking suffix, if any.
 * Empty when the default is absent or points at a role the preset doesn't assign.
 */
export function resolveOmpPresetDefaultCandidates(
  preset: Pick<OmpModelPreset, "modelRoles">,
): { selector: string; thinking?: string }[] {
  let value = preset.modelRoles.default;
  for (let hops = 0; value?.startsWith("@") && hops < 8; hops++) {
    value = preset.modelRoles[value.slice(1)];
  }
  if (value === undefined || value.startsWith("@")) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(splitOmpSelectorThinking);
}

/**
 * Effective `modelPresets` (sorted by name) and effective `modelRoles` (role → selector)
 * for a session in `cwd`, across global, project, and `PI_CONFIG_FILES` layers.
 */
export async function resolveOmpModelPresets(
  args: ResolveOmpNativeRootsArgs,
): Promise<{ presets: OmpModelPreset[]; modelRoles: Record<string, string> }> {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const layers = await loadSettingsLayers(args, resolveOmpAgentDir(args, cwd), cwd);
  const owners = new Map<string, { raw: unknown; source: OmpConfigLayer }>();
  let settings: OmpSettings = {};
  for (const layer of layers) {
    settings = mergeSettings(settings, layer.settings);
    for (const [name, raw] of Object.entries(layer.settings?.modelPresets ?? {})) {
      owners.set(name, { raw, source: layer.source });
    }
  }
  const presets: OmpModelPreset[] = [];
  for (const [name, { raw, source }] of owners) {
    if (!OMP_MODEL_PRESET_NAME_PATTERN.test(name)) continue;
    const preset = parseModelPreset(raw);
    if (preset) presets.push({ name, source, ...preset });
  }
  presets.sort((a, b) => a.name.localeCompare(b.name));
  const modelRoles: Record<string, string> = {};
  for (const [role, raw] of Object.entries(settings.modelRoles ?? {})) {
    const value = roleValueFromUnknown(raw);
    if (value !== undefined && value !== "") modelRoles[role] = value;
  }
  return { presets, modelRoles };
}

export const OMP_MODEL_PRESET_ID_PREFIX = "preset:";

/** The bb model-picker id for a preset, e.g. `preset:best-coder`. */
export function toOmpModelPresetId(name: string): string {
  return `${OMP_MODEL_PRESET_ID_PREFIX}${name}`;
}

/** The preset name in a bb model-picker id, or undefined for a real model id. */
export function parseOmpModelPresetId(id: string): string | undefined {
  if (!id.startsWith(OMP_MODEL_PRESET_ID_PREFIX)) return undefined;
  const name = id.slice(OMP_MODEL_PRESET_ID_PREFIX.length);
  return OMP_MODEL_PRESET_NAME_PATTERN.test(name) ? name : undefined;
}

export async function resolveOmpNativeRoots(
  args: ResolveOmpNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const homeDir = path.resolve(args.homeDir);
  const agentDir = resolveOmpAgentDir(args, cwd);
  const settings = await loadSettings(args, agentDir, cwd);
  const skills = settings.skills ?? {};
  if (skills.enabled === false) return { skills: [] };

  const disabled = new Set(settings.disabledProviders);
  const enabled = new Set(settings.enabledProviders);
  const userSourceEnabled = (source: string): boolean =>
    enabled.has(source) || enabled.has("*") || enabled.has("all");
  const roots = new Map<string, SkillRoot>();
  const add = (rootPath: string, origin: "user" | "project"): void => {
    const absolutePath = path.resolve(rootPath);
    if (!roots.has(absolutePath)) {
      // OMP scanSkillsFromDir reads immediate <name>/SKILL.md children only.
      roots.set(absolutePath, {
        path: absolutePath,
        origin,
        recursive: false,
        shape: "skills",
      });
    }
  };
  const ancestors =
    args.cwd === null ? [] : await projectAncestorDirs(cwd, args.homeDir);
  const projectRoots = (dir: string): void => {
    for (const ancestor of ancestors) {
      if (ancestor === homeDir) continue;
      add(path.join(ancestor, dir, "skills"), "project");
    }
  };

  if (!disabled.has("native")) {
    if (skills.enablePiProject !== false) projectRoots(".omp");
    if (skills.enablePiUser !== false) add(path.join(agentDir, "skills"), "user");
  }
  if (!disabled.has("skillshare")) {
    const locks: { path: string; origin: "user" | "project" }[] = ancestors.map(
      (ancestor) => ({
        path: path.join(ancestor, ".omp", "skills.lock.json"),
        origin: "project",
      }),
    );
    locks.push({
      path: path.join(agentDir, "skills.lock.json"),
      origin: "user",
    });
    for (const lock of locks) {
      const found = await lockedSkillRoots(lock.path, agentDir, lock.origin);
      for (const root of found) {
        if (!roots.has(root.path)) roots.set(root.path, root);
      }
    }
  }
  if (!disabled.has("agents")) {
    for (const dir of [".agent", ".agents"]) {
      if (skills.enableAgentsProject !== false) projectRoots(dir);
      if (skills.enableAgentsUser !== false) {
        add(path.join(args.homeDir, dir, "skills"), "user");
      }
    }
  }
  if (!disabled.has("claude")) {
    if (skills.enableClaudeProject !== false) projectRoots(".claude");
    const claudeDir = args.env.CLAUDE_CONFIG_DIR?.trim();
    if (skills.enableClaudeUser || userSourceEnabled("claude") || claudeDir) {
      add(
        path.join(
          claudeDir
            ? path.resolve(cwd, claudeDir)
            : path.join(args.homeDir, ".claude"),
          "skills",
        ),
        "user",
      );
    }
  }
  if (!disabled.has("codex")) {
    if (args.cwd !== null) add(path.join(cwd, ".codex", "skills"), "project");
    if (skills.enableCodexUser || userSourceEnabled("codex")) {
      add(path.join(args.homeDir, ".codex", "skills"), "user");
    }
  }
  if (!disabled.has("opencode")) {
    if (args.cwd !== null) add(path.join(cwd, ".opencode", "skills"), "project");
    if (userSourceEnabled("opencode")) {
      add(path.join(args.homeDir, ".config", "opencode", "skills"), "user");
    }
  }
  if (args.cwd !== null && !disabled.has("github")) {
    add(path.join(cwd, ".github", "skills"), "project");
  }
  if (!disabled.has("omp-managed")) {
    add(path.join(agentDir, "managed-skills"), "user");
  }
  // customDirectories are literal directory paths, not Pi package sources.
  // OMP expands ~, then resolves relative paths from the session's cwd.
  for (const dir of skills.customDirectories ?? []) {
    if (dir) add(path.resolve(cwd, expandTilde(args.homeDir, dir)), "user");
  }
  return {
    skills: experimental_filterResolvedNativeRoots(
      { skills: [...roots.values()] },
      { warn: console.warn },
    ).answer.skills,
  };
}
