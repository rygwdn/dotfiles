import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { isMap, isScalar, parseDocument, type Document, type YAMLMap } from "yaml";
import { z } from "zod";
import {
  OMP_PRESET_DEFAULT_THINKING_LEVELS,
  ompModelPresetValueSchema,
  type OmpEditableModelPreset,
  type OmpModelPresetValue,
  type OmpModelPresetsRevision,
  type OmpModelPresetsSnapshot,
} from "./model-presets-contract.js";
import {
  OMP_MODEL_PRESET_NAME_PATTERN,
  resolveOmpGlobalConfigPath,
  type ResolveOmpNativeRootsArgs,
} from "./native-roots.js";

const storedSettingsSchema = z.object({
  modelRoles: z.record(z.string(), z.unknown()).optional().catch(undefined),
  modelPresets: z.record(z.string(), z.unknown()).optional().catch(undefined),
});
const storedPresetSchema = ompModelPresetValueSchema.strip();
type StoredSettings = z.infer<typeof storedSettingsSchema>;

interface ConfigSource {
  configPath: string;
  content: Buffer | null;
  revision: OmpModelPresetsRevision;
  mode: number | null;
  legacy: boolean;
}

interface SaveInput {
  name: string;
  previousName?: string;
  preset: OmpModelPresetValue;
  expectedRevision: OmpModelPresetsRevision;
}

interface DeleteInput {
  name: string;
  expectedRevision: OmpModelPresetsRevision;
}

export interface OmpModelPresetsConfig {
  list(): Promise<OmpModelPresetsSnapshot>;
  save(input: SaveInput): Promise<OmpModelPresetsSnapshot>;
  delete(input: DeleteInput): Promise<OmpModelPresetsSnapshot>;
}

// A host worker may create editors whose logical paths share one physical config.
const mutationQueues = new Map<string, Promise<void>>();
const MAX_SYMLINK_HOPS = 40;

async function resolveYamlWritePath(configPath: string): Promise<string> {
  try {
    return await realpath(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    if (!(await lstat(configPath)).isSymbolicLink()) return resolve(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(configPath);
  }

  // realpath cannot resolve a dangling chain. Follow every link so atomic
  // replacement recreates the final target, never a user-managed symlink.
  let current = configPath;
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
    let target: string;
    try {
      target = await readlink(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return current === configPath ? resolve(configPath) : current;
    }

    let physical = isAbsolute(target) ? parse(target).root : dirname(current);
    if (!isAbsolute(target)) {
      try {
        physical = await realpath(physical);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // POSIX must traverse directory aliases before applying `..`; resolving
    // the whole target lexically could write to an unrelated sibling instead.
    // Windows normalizes dot segments before following directory links.
    const spelled = sep === "\\" ? normalize(target) : target;
    const body = isAbsolute(spelled) ? spelled.slice(parse(spelled).root.length) : spelled;
    let frozen = false;
    for (const segment of body.split(sep === "\\" ? /[\\/]+/u : /\/+/u)) {
      if (segment === "" || segment === "." || segment === "..") {
        let directory = false;
        if (!frozen) {
          try {
            directory = (await stat(physical)).isDirectory();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        // A missing component cannot be entered by `..`, `/`, or `/.`.
        // Dropping that requirement would create a file the link cannot read.
        if (!directory) {
          throw Object.assign(new Error(`ENOTDIR: symlink target requires a directory at "${physical}" for "${configPath}".`), { code: "ENOTDIR" });
        }
        if (segment === "..") physical = dirname(physical);
        continue;
      }
      const candidate = join(physical, segment);
      if (frozen) {
        physical = candidate;
        continue;
      }
      try {
        physical = await realpath(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        physical = candidate;
        frozen = true;
      }
    }

    try {
      if (!(await lstat(physical)).isSymbolicLink()) return physical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return physical;
    }
    current = physical;
  }
  // A dangling chain can turn cyclic after the initial realpath check.
  throw Object.assign(new Error(`ELOOP: symlink chain for "${configPath}" exceeds ${MAX_SYMLINK_HOPS} hops (possible cycle).`), { code: "ELOOP" });
}

function serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const result = (mutationQueues.get(key) ?? Promise.resolve()).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  mutationQueues.set(key, settled);
  void settled.then(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  return result;
}

function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function conflict(configPath: string): Error {
  return new Error(`OMP global config "${configPath}" changed since it was loaded. Reload the presets and try again.`);
}

function assertRevision(source: ConfigSource, expected: OmpModelPresetsRevision): void {
  if (
    source.revision.mtimeMs !== expected.mtimeMs ||
    source.revision.contentHash !== expected.contentHash
  ) {
    throw conflict(source.configPath);
  }
}

async function readSourceFile(configPath: string, legacy: boolean): Promise<ConfigSource | null> {
  let file;
  try {
    file = await open(configPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`OMP global config "${configPath}" must be a regular file.`);
    const content = await file.readFile();
    const after = await file.stat();
    if (
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    ) {
      throw conflict(configPath);
    }
    return {
      configPath,
      content,
      revision: { mtimeMs: after.mtimeMs, contentHash: contentHash(content) },
      mode: after.mode & 0o777,
      legacy,
    };
  } finally {
    await file.close();
  }
}

async function readSource(args: ResolveOmpNativeRootsArgs): Promise<ConfigSource> {
  const configPath = await resolveOmpGlobalConfigPath(args);
  const yaml = await readSourceFile(configPath, false);
  if (yaml) return yaml;
  const legacy = await readSourceFile(join(dirname(configPath), "settings.json"), true);
  return legacy ?? {
    configPath,
    content: null,
    revision: { mtimeMs: null, contentHash: null },
    mode: null,
    legacy: false,
  };
}

function parseYaml(source: ConfigSource): Document {
  const document: Document = parseDocument(source.content?.toString("utf8") ?? "{}\n");
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML in OMP global config "${source.configPath}": ${document.errors[0].message}`);
  }
  if (document.contents === null) document.contents = document.createNode({});
  if (!isMap(document.contents)) {
    throw new Error(`OMP global config "${source.configPath}" must contain a YAML mapping.`);
  }
  return document;
}

function readSettings(source: ConfigSource): StoredSettings {
  if (!source.legacy) return storedSettingsSchema.parse(parseYaml(source).toJS());
  const errors: ParseError[] = [];
  const parsed = storedSettingsSchema.safeParse(parseJsonc(source.content!.toString("utf8"), errors, { allowTrailingComma: true }));
  if (errors.length > 0 || !parsed.success) {
    throw new Error(`Invalid legacy OMP global config "${source.configPath}"; it must contain a JSON object.`);
  }
  return parsed.data;
}

function snapshot(source: ConfigSource, settings = readSettings(source)): OmpModelPresetsSnapshot {
  const presets: OmpEditableModelPreset[] = [];
  if (settings.modelPresets) {
    for (const [name, raw] of Object.entries(settings.modelPresets)) {
      if (!OMP_MODEL_PRESET_NAME_PATTERN.test(name)) continue;
      const parsed = storedPresetSchema.safeParse(raw);
      if (parsed.success) presets.push({ name, ...parsed.data });
    }
  }
  presets.sort((a, b) => a.name.localeCompare(b.name));
  const modelRoles = Object.fromEntries(Object.entries(settings.modelRoles ?? {}).filter((entry): entry is [string, string] => (
    typeof entry[1] === "string" && entry[1] !== ""
  )));
  const stablePresets = presets.map((preset) => [
    preset.name,
    Object.entries(preset.modelRoles).sort(([a], [b]) => a.localeCompare(b)),
    preset.defaultThinkingLevel ?? null,
  ]);
  return {
    configPath: source.configPath,
    revision: source.revision,
    presetsRevision: contentHash(JSON.stringify(stablePresets)),
    presets,
    modelRoles,
  };
}

function validateName(name: string): void {
  if (typeof name !== "string" || OMP_MODEL_PRESET_NAME_PATTERN.exec(name)?.[0] !== name) {
    throw new Error("OMP preset names must start with a letter and contain only letters, digits, underscores, or hyphens.");
  }
}

function presetMap(document: Document): YAMLMap {
  if (!document.has("modelPresets")) document.setIn(["modelPresets"], document.createNode({}));
  const presets = document.getIn(["modelPresets"], true);
  if (!isMap(presets)) throw new Error("OMP global config modelPresets must be a YAML mapping before it can be edited.");
  return presets;
}

function savePreset(document: Document, input: SaveInput, preset: OmpModelPresetValue): void {
  const presets = presetMap(document);
  if (input.previousName === undefined) {
    if (presets.has(input.name)) throw new Error(`OMP preset "${input.name}" already exists. Choose another name.`);
    document.setIn(["modelPresets", input.name], document.createNode({ modelRoles: {} }));
  } else {
    if (!presets.has(input.previousName)) {
      throw new Error(`OMP preset "${input.previousName}" no longer exists. Reload the presets and try again.`);
    }
    if (input.previousName !== input.name) {
      if (presets.has(input.name)) throw new Error(`OMP preset "${input.name}" already exists. Choose another name.`);
      // Rename the scalar key in place: its comments, order, and any anchored value survive.
      const entry = presets.items.find(({ key }) => isScalar(key) && key.value === input.previousName);
      if (!entry || !isScalar(entry.key)) throw new Error(`Cannot safely rename OMP preset "${input.previousName}".`);
      entry.key.value = input.name;
    }
  }
  const path = ["modelPresets", input.name];
  if (!isMap(document.getIn(path, true))) throw new Error(`OMP preset "${input.name}" must be a YAML mapping before it can be edited.`);
  const rolesPath = [...path, "modelRoles"];
  if (!document.hasIn(rolesPath)) document.setIn(rolesPath, document.createNode({}));
  const roles = document.getIn(rolesPath, true);
  if (!isMap(roles)) throw new Error(`OMP preset "${input.name}" modelRoles must be a YAML mapping before it can be edited.`);
  for (const { key } of [...roles.items]) {
    if (!isScalar(key) || typeof key.value !== "string") {
      throw new Error(`OMP preset "${input.name}" role names must be strings before it can be edited.`);
    }
    if (!Object.hasOwn(preset.modelRoles, key.value)) document.deleteIn([...rolesPath, key.value]);
  }
  for (const [role, selector] of Object.entries(preset.modelRoles)) {
    document.setIn([...rolesPath, role], selector);
  }
  if (preset.defaultThinkingLevel === undefined) document.deleteIn([...path, "defaultThinkingLevel"]);
  else document.setIn([...path, "defaultThinkingLevel"], preset.defaultThinkingLevel);
}

async function writeDocument(
  args: ResolveOmpNativeRootsArgs,
  source: ConfigSource,
  document: Document,
  writePath: string,
): Promise<OmpModelPresetsSnapshot> {
  const content = Buffer.from(document.toString(), "utf8");
  const settings = storedSettingsSchema.parse(document.toJS());
  const directory = dirname(writePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(writePath)}.bb-presets-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    created = true;
    let mtimeMs: number;
    try {
      await file.writeFile(content);
      if (source.mode !== null) await file.chmod(source.mode);
      await file.sync();
      mtimeMs = (await file.stat()).mtimeMs;
    } finally {
      await file.close();
    }
    // Re-read both bytes and metadata after preparing the temp, immediately before rename.
    const latest = await readSource(args);
    if (latest.configPath !== source.configPath || latest.legacy !== source.legacy) throw conflict(source.configPath);
    assertRevision(latest, source.revision);
    if (await resolveYamlWritePath(source.configPath) !== writePath) throw conflict(source.configPath);
    await rename(temporaryPath, writePath);
    return snapshot({
      ...source,
      content,
      revision: { mtimeMs, contentHash: contentHash(content) },
    }, settings);
  } finally {
    if (created) await rm(temporaryPath, { force: true });
  }
}

export function createOmpModelPresetsConfig(args: ResolveOmpNativeRootsArgs): OmpModelPresetsConfig {
  async function mutate(
    expected: OmpModelPresetsRevision,
    update: (document: Document) => void,
  ): Promise<OmpModelPresetsSnapshot> {
    const configPath = await resolveOmpGlobalConfigPath(args);
    const writePath = await resolveYamlWritePath(configPath);
    return serializeMutation(writePath, async () => {
      const source = await readSource(args);
      assertRevision(source, expected);
      if (source.legacy) {
        throw new Error(`OMP global config "${source.configPath}" is legacy settings.json. Open OMP once to migrate it to config.yml before editing presets here.`);
      }
      if (source.configPath !== configPath || await resolveYamlWritePath(configPath) !== writePath) throw conflict(configPath);
      const document = parseYaml(source);
      update(document);
      return writeDocument(args, source, document, writePath);
    });
  }

  return {
    async list(): Promise<OmpModelPresetsSnapshot> {
      return snapshot(await readSource(args));
    },
    async save(input: SaveInput): Promise<OmpModelPresetsSnapshot> {
      validateName(input.name);
      if (input.previousName !== undefined) validateName(input.previousName);
      const preset = ompModelPresetValueSchema.parse(input.preset);
      if (Object.keys(preset.modelRoles).length === 0) throw new Error("An OMP preset must contain at least one model role.");
      if (preset.defaultThinkingLevel !== undefined && !(OMP_PRESET_DEFAULT_THINKING_LEVELS as readonly string[]).includes(preset.defaultThinkingLevel)) {
        throw new Error(`Unsupported OMP default thinking level "${preset.defaultThinkingLevel}". Choose ${OMP_PRESET_DEFAULT_THINKING_LEVELS.join(", ")}.`);
      }
      return mutate(input.expectedRevision, (document) => savePreset(document, input, preset));
    },
    async delete(input: DeleteInput): Promise<OmpModelPresetsSnapshot> {
      validateName(input.name);
      return mutate(input.expectedRevision, (document) => {
        const presets = presetMap(document);
        if (!presets.has(input.name)) throw new Error(`OMP preset "${input.name}" no longer exists. Reload the presets and try again.`);
        document.deleteIn(["modelPresets", input.name]);
      });
    },
  };
}
