import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { OmpModelPresetsRevision } from "./model-presets-contract.js";
import { createOmpModelPresetsConfig, type OmpModelPresetsConfig } from "./model-presets-config.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath), rename: vi.fn(actual.rename) };
});

let homeDir: string;
let cwd: string;
let agentDir: string;
let configPath: string;
let store: OmpModelPresetsConfig;
let actualFs: typeof fs;

beforeEach(async () => {
  actualFs = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
  vi.mocked(fs.realpath).mockReset().mockImplementation(actualFs.realpath);
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  homeDir = mkdtempSync(join(tmpdir(), "bb-omp-model-presets-"));
  cwd = join(homeDir, "project");
  agentDir = join(homeDir, ".omp", "agent");
  configPath = join(agentDir, "config.yml");
  mkdirSync(cwd, { recursive: true });
  store = createOmpModelPresetsConfig({ homeDir, cwd, env: {} });
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function writeConfig(content: string, filePath = configPath): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function fileRevision(filePath = configPath): OmpModelPresetsRevision {
  return {
    mtimeMs: statSync(filePath).mtimeMs,
    contentHash: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
  };
}

it("lists only normalized global presets and roles, preserving opaque selectors", async () => {
  writeConfig(`modelRoles:
  default: global-alias
  reviewer: 'provider/model*:high'
  empty: ''
  invalid: [not-a-selector]
modelPresets:
  zeta:
    modelRoles: {default: alias, reviewer: 'provider/model*:high'}
    defaultThinkingLevel: high
    futureSetting: retained
  alpha:
    modelRoles: {default: 'a/provider-model'}
  malformed:
    modelRoles: {default: 42}
  blank:
    modelRoles: {default: '  '}
  bad.name:
    modelRoles: {default: hidden}
`);
  writeConfig("modelRoles: {default: project}\nmodelPresets: {project: {modelRoles: {default: project}}}\n", join(cwd, ".omp", "config.yml"));
  writeConfig('{"modelPresets":{"legacyProject":{"modelRoles":{"default":"project"}}}}', join(cwd, ".omp", "settings.json"));
  const overlayPath = join(homeDir, "overlay.yml");
  writeConfig("modelRoles: {default: overlay}\nmodelPresets: {overlay: {modelRoles: {default: overlay}}}\n", overlayPath);
  const globalOnly = createOmpModelPresetsConfig({ homeDir, cwd, env: { PI_CONFIG_FILES: overlayPath } });

  const listed = await globalOnly.list();
  expect(listed.configPath).toBe(configPath);
  expect(listed.revision).toEqual(fileRevision());
  expect(listed.presets).toEqual([
    { name: "alpha", modelRoles: { default: "a/provider-model" } },
    { name: "zeta", modelRoles: { default: "alias", reviewer: "provider/model*:high" }, defaultThinkingLevel: "high" },
  ]);
  expect(listed.modelRoles).toEqual({ default: "global-alias", reviewer: "provider/model*:high" });
  expect(listed.presetsRevision).toMatch(/^[a-f0-9]{64}$/u);
});

it("saves without losing comments, unrelated keys, future preset fields, or file mode", async () => {
  writeConfig(`# Personal OMP configuration
 theme: light # Theme stays
 network:
   timeout: 30 # Network stays
 modelRoles:
   default: global-alias
 modelPresets:
   # Preset key stays
   everyday:
     # Role map stays
     modelRoles:
       default: old/model # Default role stays
       obsolete: old/unused
     defaultThinkingLevel: low # Thinking comment stays
     futureSetting: opaque # Future field stays
   untouched:
     modelRoles: {default: untouched/model}
 # Footer stays
`);
  chmodSync(configPath, 0o640);
  const before = await store.list();
  const saved = await store.save({
    name: "everyday",
    previousName: "everyday",
    preset: { modelRoles: { default: "opaque-alias", smol: "provider/model*:low" }, defaultThinkingLevel: "high" },
    expectedRevision: before.revision,
  });

  const content = readFileSync(configPath, "utf8");
  for (const comment of ["Personal OMP configuration", "Theme stays", "Network stays", "Preset key stays", "Role map stays", "Default role stays", "Thinking comment stays", "Future field stays", "Footer stays"]) {
    expect(content).toContain(`# ${comment}`);
  }
  expect(parseYaml(content)).toEqual({
    theme: "light",
    network: { timeout: 30 },
    modelRoles: { default: "global-alias" },
    modelPresets: {
      everyday: {
        modelRoles: { default: "opaque-alias", smol: "provider/model*:low" },
        defaultThinkingLevel: "high",
        futureSetting: "opaque",
      },
      untouched: { modelRoles: { default: "untouched/model" } },
    },
  });
  expect(saved.revision).toEqual(fileRevision());
  expect(saved.modelRoles).toEqual(before.modelRoles);
  expect(saved.presetsRevision).not.toBe(before.presetsRevision);
  expect(statSync(configPath).mode & 0o777).toBe(0o640);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("renames in place, removes the old key, and preserves preset comments and anchors", async () => {
  writeConfig(`modelPresets:
  # Name comment stays
  old: &shared
    modelRoles: {default: 'opaque/*:high'}
    defaultThinkingLevel: high
  other:
    modelRoles: {default: other-alias}
sharedSettings: *shared
`);
  const before = await store.list();
  const saved = await store.save({
    name: "Renamed_2",
    previousName: "old",
    preset: { modelRoles: { default: "opaque/*:max" } },
    expectedRevision: before.revision,
  });

  const content = readFileSync(configPath, "utf8");
  const parsed = parseYaml(content);
  expect(parsed.modelPresets.old).toBeUndefined();
  expect(Object.keys(parsed.modelPresets)).toEqual(["Renamed_2", "other"]);
  expect(parsed.modelPresets.Renamed_2).toEqual({ modelRoles: { default: "opaque/*:max" } });
  expect(parsed.sharedSettings).toEqual(parsed.modelPresets.Renamed_2);
  expect(content).toContain("# Name comment stays");
  expect(content).toContain("&shared");
  expect(content).toContain("*shared");
  expect(saved.presets.map(({ name }) => name)).toEqual(["other", "Renamed_2"]);
  expect(saved.revision).toEqual(fileRevision());
});

it("deletes only the named preset", async () => {
  writeConfig(`# Global comment stays
 theme: dark
 modelPresets:
   remove:
     modelRoles: {default: remove-alias}
   # Other preset stays
   keep:
     modelRoles: {default: keep-alias}
`);
  const before = await store.list();
  const deleted = await store.delete({ name: "remove", expectedRevision: before.revision });
  const content = readFileSync(configPath, "utf8");

  expect(parseYaml(content)).toEqual({ theme: "dark", modelPresets: { keep: { modelRoles: { default: "keep-alias" } } } });
  expect(content).toContain("# Global comment stays");
  expect(content).toContain("# Other preset stays");
  expect(deleted.presets).toEqual([{ name: "keep", modelRoles: { default: "keep-alias" } }]);
  expect(deleted.revision).toEqual(fileRevision());
  await expect(store.delete({ name: "remove", expectedRevision: deleted.revision })).rejects.toThrow(/no longer exists/u);
});

it("creates missing parent directories and a private global config", async () => {
  const before = await store.list();
  expect(before).toMatchObject({ configPath, revision: { mtimeMs: null, contentHash: null }, presets: [], modelRoles: {} });
  expect(existsSync(agentDir)).toBe(false);

  const saved = await store.save({
    name: "New_preset-2",
    preset: { modelRoles: { default: "opaque-alias" } },
    expectedRevision: before.revision,
  });
  expect(parseYaml(readFileSync(configPath, "utf8"))).toEqual({
    modelPresets: { "New_preset-2": { modelRoles: { default: "opaque-alias" } } },
  });
  expect(statSync(agentDir).mode & 0o777).toBe(0o700);
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
  expect(saved.revision).toEqual(fileRevision());
  expect(await store.list()).toEqual(saved);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("saves and deletes through an existing config symlink without replacing it", async () => {
  const targetPath = join(homeDir, "managed", "omp.yml");
  writeConfig("# Managed preferences stay\ntheme: dark\nmodelPresets: {keep: {modelRoles: {default: keep-alias}}}\n", targetPath);
  chmodSync(targetPath, 0o640);
  mkdirSync(agentDir, { recursive: true });
  symlinkSync(targetPath, configPath);
  const physicalTarget = realpathSync(targetPath);
  const before = await store.list();
  expect(before.configPath).toBe(configPath);
  expect(before.revision).toEqual(fileRevision(targetPath));

  const saved = await store.save({
    name: "added",
    preset: { modelRoles: { default: "new-alias" } },
    expectedRevision: before.revision,
  });
  expect(saved.configPath).toBe(configPath);
  expect(saved.revision).toEqual(fileRevision(targetPath));
  expect(await store.list()).toEqual(saved);
  expect(parseYaml(readFileSync(targetPath, "utf8")).modelPresets.added).toEqual({ modelRoles: { default: "new-alias" } });
  expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(configPath)).toBe(targetPath);

  const deleted = await store.delete({ name: "added", expectedRevision: saved.revision });
  expect(deleted.configPath).toBe(configPath);
  expect(deleted.revision).toEqual(fileRevision(targetPath));
  expect(await store.list()).toEqual(deleted);
  expect(parseYaml(readFileSync(targetPath, "utf8"))).toEqual({
    theme: "dark",
    modelPresets: { keep: { modelRoles: { default: "keep-alias" } } },
  });
  expect(readFileSync(targetPath, "utf8")).toContain("# Managed preferences stay");
  expect(statSync(targetPath).mode & 0o777).toBe(0o640);
  expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(configPath)).toBe(targetPath);
  expect(fs.rename).toHaveBeenCalledTimes(2);
  for (const [temporaryPath, destination] of vi.mocked(fs.rename).mock.calls) {
    expect(dirname(String(temporaryPath))).toBe(dirname(physicalTarget));
    expect(destination).toBe(physicalTarget);
    expect(temporaryPath).toMatch(/\.bb-presets-.*\.tmp$/u);
  }
  const staged = vi.mocked(fs.open).mock.calls.filter(([filePath]) => String(filePath).includes(".bb-presets-"));
  expect(staged).toHaveLength(2);
  for (const [temporaryPath, flags, mode] of staged) {
    expect(dirname(String(temporaryPath))).toBe(dirname(physicalTarget));
    expect(flags).toBe("wx");
    expect(mode).toBe(0o600);
  }
  expect(readdirSync(dirname(targetPath))).toEqual(["omp.yml"]);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("creates the final missing target of a relative dangling link chain and preserves every link", async () => {
  const intermediatePath = join(homeDir, "links", "next.yml");
  const targetPath = join(homeDir, "managed", "new", "omp.yml");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dirname(intermediatePath), { recursive: true });
  const firstTarget = relative(agentDir, intermediatePath);
  const finalTarget = relative(dirname(intermediatePath), targetPath);
  symlinkSync(firstTarget, configPath);
  symlinkSync(finalTarget, intermediatePath);
  const before = await store.list();
  expect(before.configPath).toBe(configPath);
  expect(before.revision).toEqual({ mtimeMs: null, contentHash: null });

  const saved = await store.save({
    name: "created",
    preset: { modelRoles: { default: "alias" } },
    expectedRevision: before.revision,
  });
  expect(parseYaml(readFileSync(targetPath, "utf8"))).toEqual({
    modelPresets: { created: { modelRoles: { default: "alias" } } },
  });
  expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(configPath)).toBe(firstTarget);
  expect(lstatSync(intermediatePath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(intermediatePath)).toBe(finalTarget);
  expect(saved.configPath).toBe(configPath);
  expect(saved.revision).toEqual(fileRevision(targetPath));
  expect(await store.list()).toEqual(saved);
  expect(statSync(dirname(targetPath)).mode & 0o777).toBe(0o700);
  expect(statSync(targetPath).mode & 0o777).toBe(0o600);
  const [temporaryPath, destination] = vi.mocked(fs.rename).mock.calls[0]!;
  expect(dirname(String(temporaryPath))).toBe(realpathSync(dirname(targetPath)));
  expect(destination).toBe(realpathSync(targetPath));
  expect(readdirSync(dirname(targetPath))).toEqual(["omp.yml"]);
  expect(readdirSync(dirname(intermediatePath))).toEqual(["next.yml"]);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it.each(["relative", "absolute"])("follows directory aliases before dot-dot in a dangling %s target", async (kind) => {
  const managedDir = join(homeDir, "managed");
  const aliasedDir = join(managedDir, "nested");
  mkdirSync(aliasedDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const directoryLink = join(agentDir, "alias");
  symlinkSync(aliasedDir, directoryLink, "dir");
  // Do not path.join this spelling: normalizing alias/.. is the bug under test.
  const relativeTarget = `alias${sep}..${sep}created${sep}omp.yml`;
  const target = kind === "relative" ? relativeTarget : `${agentDir}${sep}${relativeTarget}`;
  symlinkSync(target, configPath);
  const expectedPath = join(sep === "\\" ? agentDir : managedDir, "created", "omp.yml");
  const before = await store.list();
  const saved = await store.save({
    name: "created",
    preset: { modelRoles: { default: "alias" } },
    expectedRevision: before.revision,
  });

  expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(configPath)).toBe(target);
  expect(lstatSync(directoryLink).isSymbolicLink()).toBe(true);
  expect(readlinkSync(directoryLink)).toBe(aliasedDir);
  expect(saved.configPath).toBe(configPath);
  expect(saved.revision).toEqual(fileRevision(expectedPath));
  expect(await store.list()).toEqual(saved);
  expect(parseYaml(readFileSync(expectedPath, "utf8")).modelPresets.created).toEqual({ modelRoles: { default: "alias" } });
  if (sep !== "\\") expect(existsSync(join(agentDir, "created"))).toBe(false);
  const [temporaryPath, destination] = vi.mocked(fs.rename).mock.calls[0]!;
  expect(dirname(String(temporaryPath))).toBe(realpathSync(dirname(expectedPath)));
  expect(destination).toBe(realpathSync(expectedPath));
});

it.skipIf(sep === "\\").each(["missing/../foreign.yml", "missing/child/../foreign.yml", "missing/", "missing/."])(
  "rejects the untraversable dangling target %j without replacing the link",
  async (target) => {
    mkdirSync(agentDir, { recursive: true });
    symlinkSync(target, configPath);
    await expect(store.save({
      name: "new",
      preset: { modelRoles: { default: "alias" } },
      expectedRevision: { mtimeMs: null, contentHash: null },
    })).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(target);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(readdirSync(agentDir)).toEqual(["config.yml"]);
  },
);

it("bounds a dangling chain that becomes cyclic during path resolution", async () => {
  mkdirSync(agentDir, { recursive: true });
  const intermediatePath = join(agentDir, "next.yml");
  symlinkSync("next.yml", configPath);
  symlinkSync("missing.yml", intermediatePath);
  const before = await store.list();
  let retargeted = false;
  vi.mocked(fs.realpath).mockImplementation(async (filePath, options) => {
    if (String(filePath).endsWith(`${sep}config.yml`) || String(filePath).endsWith(`${sep}next.yml`)) {
      if (!retargeted) {
        retargeted = true;
        rmSync(intermediatePath);
        symlinkSync("config.yml", intermediatePath);
      }
      // Model concurrent retargets that keep realpath seeing a dangling chain
      // even though each lstat/readlink sees another existing symlink.
      throw Object.assign(new Error("temporarily dangling"), { code: "ENOENT" });
    }
    return actualFs.realpath(filePath, options);
  });

  await expect(store.save({
    name: "new",
    preset: { modelRoles: { default: "alias" } },
    expectedRevision: before.revision,
  })).rejects.toMatchObject({ code: "ELOOP" });
  expect(retargeted).toBe(true);
  expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(configPath)).toBe("next.yml");
  expect(lstatSync(intermediatePath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(intermediatePath)).toBe("config.yml");
  expect(fs.rename).not.toHaveBeenCalled();
  expect(readdirSync(agentDir)).toEqual(["config.yml", "next.yml"]);
});

it.each(["", " \n\n", "# Personal OMP preferences\n# Keep this header\n"])("initializes an existing blank or comment-only config %j without losing its header", async (original) => {
  writeConfig(original);
  const before = await store.list();
  expect(before.presets).toEqual([]);
  expect(before.modelRoles).toEqual({});
  expect(before.revision).toEqual(fileRevision());
  expect(readFileSync(configPath, "utf8")).toBe(original);

  const saved = await store.save({
    name: "first",
    preset: { modelRoles: { default: "opaque-alias" } },
    expectedRevision: before.revision,
  });
  const content = readFileSync(configPath, "utf8");
  if (original.startsWith("#")) expect(content.startsWith(original)).toBe(true);
  expect(parseYaml(content)).toEqual({
    modelPresets: { first: { modelRoles: { default: "opaque-alias" } } },
  });
  expect(saved.revision).toEqual(fileRevision());
  expect(await store.list()).toEqual(saved);
});

it("detects external content changes even when mtime is unchanged", async () => {
  writeConfig("theme: original\n");
  const time = new Date("2026-01-02T03:04:05.000Z");
  utimesSync(configPath, time, time);
  const before = await store.list();
  const external = "theme: external\n";
  writeFileSync(configPath, external);
  utimesSync(configPath, time, time);
  expect(fileRevision().mtimeMs).toBe(before.revision.mtimeMs);

  await expect(store.save({ name: "new", preset: { modelRoles: { default: "alias" } }, expectedRevision: before.revision })).rejects.toThrow(/changed.*Reload/u);
  expect(readFileSync(configPath, "utf8")).toBe(external);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("detects mtime-only changes before deleting", async () => {
  const original = "modelPresets: {keep: {modelRoles: {default: alias}}}\n";
  writeConfig(original);
  const before = await store.list();
  const time = new Date(before.revision.mtimeMs! + 5000);
  utimesSync(configPath, time, time);
  expect(fileRevision().contentHash).toBe(before.revision.contentHash);
  expect(fileRevision().mtimeMs).not.toBe(before.revision.mtimeMs);

  await expect(store.delete({ name: "keep", expectedRevision: before.revision })).rejects.toThrow(/changed.*Reload/u);
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

it("rechecks external edits after staging the private temp and cleans up on conflict", async () => {
  writeConfig("theme: original\n");
  const before = await store.list();
  const external = "theme: externally-edited-during-save\n";
  let staged = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actualFs.open(...args);
    if (typeof args[0] === "string" && args[0].includes(".bb-presets-")) {
      staged = true;
      expect(args[1]).toBe("wx");
      expect(args[2]).toBe(0o600);
      expect((await file.stat()).mode & 0o777).toBe(0o600);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        await sync();
        writeFileSync(configPath, external);
      };
    }
    return file;
  });

  await expect(store.save({ name: "new", preset: { modelRoles: { default: "alias" } }, expectedRevision: before.revision })).rejects.toThrow(/changed.*Reload/u);
  expect(staged).toBe(true);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(readFileSync(configPath, "utf8")).toBe(external);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it.each([true, false])("rejects intermediate link retargeting after staging (targets exist: %s) and cleans the final target directory", async (existing) => {
  const intermediatePath = join(homeDir, "links", "next.yml");
  const originalPath = join(homeDir, "original", "omp.yml");
  const replacementPath = join(homeDir, "replacement", "omp.yml");
  const original = "theme: unchanged\n";
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dirname(intermediatePath), { recursive: true });
  mkdirSync(dirname(replacementPath), { recursive: true });
  if (existing) {
    writeConfig(original, originalPath);
    writeConfig(original, replacementPath);
    const time = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(originalPath, time, time);
    utimesSync(replacementPath, time, time);
  }
  symlinkSync(intermediatePath, configPath);
  symlinkSync(originalPath, intermediatePath);
  const before = await store.list();
  let staged = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actualFs.open(...args);
    if (typeof args[0] === "string" && args[0].includes(".bb-presets-")) {
      staged = true;
      expect(dirname(args[0])).toBe(realpathSync(dirname(originalPath)));
      const sync = file.sync.bind(file);
      file.sync = async () => {
        await sync();
        rmSync(intermediatePath);
        symlinkSync(replacementPath, intermediatePath);
      };
    }
    return file;
  });

  await expect(store.save({
    name: "new",
    preset: { modelRoles: { default: "alias" } },
    expectedRevision: before.revision,
  })).rejects.toThrow(/changed.*Reload/u);
  expect(staged).toBe(true);
  // Equal bytes/mtime (or two missing targets) cannot detect a link retarget.
  expect((await store.list()).revision).toEqual(before.revision);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(readlinkSync(configPath)).toBe(intermediatePath);
  expect(readlinkSync(intermediatePath)).toBe(replacementPath);
  expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(lstatSync(intermediatePath).isSymbolicLink()).toBe(true);
  expect(existsSync(originalPath)).toBe(existing);
  expect(existsSync(replacementPath)).toBe(existing);
  if (existing) {
    expect(readFileSync(originalPath, "utf8")).toBe(original);
    expect(readFileSync(replacementPath, "utf8")).toBe(original);
  }
  expect(readdirSync(dirname(originalPath))).toEqual(existing ? ["omp.yml"] : []);
  expect(readdirSync(dirname(replacementPath))).toEqual(existing ? ["omp.yml"] : []);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("removes the temp when atomic rename fails without replacing the original", async () => {
  const original = "theme: original\n";
  writeConfig(original);
  const before = await store.list();
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error("simulated rename failure"));

  await expect(store.save({ name: "new", preset: { modelRoles: { default: "alias" } }, expectedRevision: before.revision })).rejects.toThrow("simulated rename failure");
  expect(fs.rename).toHaveBeenCalledOnce();
  expect(readFileSync(configPath, "utf8")).toBe(original);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it.each(["", "1starts-with-number", "with space", "with.dot", "../outside", "a/b", "a\n"])("rejects the invalid preset name %j", async (name) => {
  const expectedRevision = { mtimeMs: null, contentHash: null };
  await expect(store.save({ name, preset: { modelRoles: { default: "alias" } }, expectedRevision })).rejects.toThrow(/preset names/u);
  await expect(store.delete({ name, expectedRevision })).rejects.toThrow(/preset names/u);
  expect(existsSync(agentDir)).toBe(false);
});

it("validates the previous name before attempting a rename", async () => {
  await expect(store.save({
    name: "valid",
    previousName: "../invalid",
    preset: { modelRoles: { default: "alias" } },
    expectedRevision: { mtimeMs: null, contentHash: null },
  })).rejects.toThrow(/preset names/u);
  expect(existsSync(agentDir)).toBe(false);
});

it("rejects empty role maps", async () => {
  await expect(store.save({
    name: "empty",
    preset: { modelRoles: {} },
    expectedRevision: { mtimeMs: null, contentHash: null },
  })).rejects.toThrow(/at least one model role/u);
  expect(existsSync(agentDir)).toBe(false);
});

it.each(["", " \t "])("rejects the empty selector %j", async (selector) => {
  await expect(store.save({
    name: "blank",
    preset: { modelRoles: { default: selector } },
    expectedRevision: { mtimeMs: null, contentHash: null },
  })).rejects.toThrow(/Choose a model/u);
  expect(existsSync(agentDir)).toBe(false);
});

it.each(["off", "unsupported"])("rejects the unsupported default thinking level %j and lists only native defaults", async (defaultThinkingLevel) => {
  await expect(store.save({
    name: "invalidThinking",
    preset: { modelRoles: { default: "alias" }, defaultThinkingLevel },
    expectedRevision: { mtimeMs: null, contentHash: null },
  })).rejects.toThrow(`Unsupported OMP default thinking level "${defaultThinkingLevel}". Choose auto, minimal, low, medium, high, xhigh, max.`);
  expect(existsSync(agentDir)).toBe(false);
});

it("accepts off in role selectors while using a native preset default", async () => {
  const preset = {
    modelRoles: { default: "provider/model:off", smol: "opaque-alias:off" },
    defaultThinkingLevel: "auto",
  };
  const saved = await store.save({
    name: "noRoleThinking",
    preset,
    expectedRevision: { mtimeMs: null, contentHash: null },
  });
  expect(saved.presets).toEqual([{ name: "noRoleThinking", ...preset }]);
  expect(parseYaml(readFileSync(configPath, "utf8")).modelPresets.noRoleThinking).toEqual(preset);
  expect(await store.list()).toEqual(saved);
});

it.each(["modelPresets: [unterminated\n", "- not-a-mapping\n", "plain scalar\n", "null\n", "theme: first\ntheme: duplicate\n"])("never replaces invalid YAML or a non-mapping file %j", async (original) => {
  writeConfig(original);
  const expectedRevision = fileRevision();
  await expect(store.list()).rejects.toThrow(/YAML/u);
  await expect(store.save({ name: "new", preset: { modelRoles: { default: "alias" } }, expectedRevision })).rejects.toThrow(/YAML/u);
  await expect(store.delete({ name: "anything", expectedRevision })).rejects.toThrow(/YAML/u);
  expect(readFileSync(configPath, "utf8")).toBe(original);
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("rejects new and rename collisions, including invalid existing entries", async () => {
  const original = "modelPresets: {first: {modelRoles: {default: first}}, second: {modelRoles: {default: second}}, broken: 42}\n";
  writeConfig(original);
  const before = await store.list();
  const preset = { modelRoles: { default: "replacement" } };

  await expect(store.save({ name: "first", preset, expectedRevision: before.revision })).rejects.toThrow(/already exists/u);
  await expect(store.save({ name: "second", previousName: "first", preset, expectedRevision: before.revision })).rejects.toThrow(/already exists/u);
  await expect(store.save({ name: "broken", preset, expectedRevision: before.revision })).rejects.toThrow(/already exists/u);
  await expect(store.save({ name: "renamed", previousName: "missing", preset, expectedRevision: before.revision })).rejects.toThrow(/no longer exists/u);
  expect(readFileSync(configPath, "utf8")).toBe(original);

  const saved = await store.save({ name: "new", preset, expectedRevision: before.revision });
  expect(saved.presets.map(({ name }) => name)).toEqual(["first", "new", "second"]);
});

it("serializes same-worker mutations across editor instances", async () => {
  const before = await store.list();
  const secondStore = createOmpModelPresetsConfig({ homeDir, cwd, env: {} });
  const results = await Promise.allSettled([
    store.save({ name: "first", preset: { modelRoles: { default: "first-alias" } }, expectedRevision: before.revision }),
    secondStore.save({ name: "second", preset: { modelRoles: { default: "second-alias" } }, expectedRevision: before.revision }),
  ]);
  const successful = results.filter((result) => result.status === "fulfilled");
  const failed = results.filter((result) => result.status === "rejected");
  expect(successful).toHaveLength(1);
  expect(failed).toHaveLength(1);
  expect(failed[0].reason).toEqual(expect.objectContaining({ message: expect.stringMatching(/changed.*Reload/u) }));
  expect((await store.list()).presets).toHaveLength(1);
  expect(fs.rename).toHaveBeenCalledOnce();
  expect(readdirSync(agentDir)).toEqual(["config.yml"]);
});

it("serializes mutations from distinct logical symlinks to the same physical config", async () => {
  const targetPath = join(homeDir, "managed", "omp.yml");
  const secondAgentDir = join(homeDir, "other-agent");
  const secondConfigPath = join(secondAgentDir, "config.yml");
  writeConfig("theme: original\n", targetPath);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(secondAgentDir, { recursive: true });
  symlinkSync(targetPath, configPath);
  symlinkSync(targetPath, secondConfigPath);
  const secondStore = createOmpModelPresetsConfig({ homeDir, cwd, env: { PI_CODING_AGENT_DIR: secondAgentDir } });
  const before = await store.list();
  const secondBefore = await secondStore.list();
  const results = await Promise.allSettled([
    store.save({ name: "first", preset: { modelRoles: { default: "first-alias" } }, expectedRevision: before.revision }),
    secondStore.save({ name: "second", preset: { modelRoles: { default: "second-alias" } }, expectedRevision: secondBefore.revision }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const failed = results.filter((result) => result.status === "rejected");
  expect(failed).toHaveLength(1);
  expect(failed[0].reason).toEqual(expect.objectContaining({ message: expect.stringMatching(/changed.*Reload/u) }));
  expect(fs.rename).toHaveBeenCalledOnce();
  expect((await store.list()).presets).toEqual((await secondStore.list()).presets);
  expect((await store.list()).presets).toHaveLength(1);
  expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  expect(lstatSync(secondConfigPath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(configPath)).toBe(targetPath);
  expect(readlinkSync(secondConfigPath)).toBe(targetPath);
  expect(readdirSync(dirname(targetPath))).toEqual(["omp.yml"]);
});

it("keeps the preset hash stable across unrelated edits and mapping order", async () => {
  writeConfig("theme: light\nmodelPresets: {beta: {modelRoles: {slow: b, default: a}}, alpha: {modelRoles: {default: c}}}\n");
  const before = await store.list();
  writeFileSync(configPath, "# New comment\ntheme: dark\nmodelPresets: {alpha: {modelRoles: {default: c}}, beta: {modelRoles: {default: a, slow: b}}}\n");
  const after = await store.list();
  expect(after.presetsRevision).toBe(before.presetsRevision);
  expect(after.revision.contentHash).not.toBe(before.revision.contentHash);
});

it("uses the profile's existing config.yaml and leaves other global files untouched", async () => {
  const originalDefault = "modelRoles: {default: default-profile}\n";
  writeConfig(originalDefault);
  const profilePath = join(homeDir, ".omp-alt", "profiles", "work", "agent", "config.yaml");
  writeConfig("modelRoles: {default: work-profile}\n", profilePath);
  const profileStore = createOmpModelPresetsConfig({
    homeDir,
    cwd,
    env: { PI_CONFIG_DIR: ".omp-alt", OMP_PROFILE: " work ", PI_PROFILE: "ignored", PI_CODING_AGENT_DIR: "ignored-agent" },
  });
  const before = await profileStore.list();
  expect(before.configPath).toBe(profilePath);
  expect(before.modelRoles).toEqual({ default: "work-profile" });
  const saved = await profileStore.save({ name: "work", preset: { modelRoles: { default: "alias" } }, expectedRevision: before.revision });
  expect(saved.configPath).toBe(profilePath);
  expect(saved.revision).toEqual(fileRevision(profilePath));
  expect(existsSync(join(dirname(profilePath), "config.yml"))).toBe(false);
  expect(existsSync(join(cwd, "ignored-agent"))).toBe(false);
  expect(readFileSync(configPath, "utf8")).toBe(originalDefault);
});

it("honors a cwd-relative PI_CODING_AGENT_DIR override", async () => {
  writeConfig("theme: default-profile\n");
  const overridePath = join(cwd, "custom-agent", "config.yml");
  const overrideStore = createOmpModelPresetsConfig({ homeDir, cwd, env: { PI_CODING_AGENT_DIR: "custom-agent" } });
  const before = await overrideStore.list();
  expect(before.configPath).toBe(overridePath);
  expect(before.revision).toEqual({ mtimeMs: null, contentHash: null });
  const saved = await overrideStore.save({ name: "override", preset: { modelRoles: { default: "alias" } }, expectedRevision: before.revision });
  expect(saved.configPath).toBe(overridePath);
  expect(saved.revision).toEqual(fileRevision(overridePath));
  expect(readFileSync(configPath, "utf8")).toBe("theme: default-profile\n");
});

it("prefers config.yml over config.yaml when both exist", async () => {
  writeConfig("theme: yml\n");
  const yamlPath = join(agentDir, "config.yaml");
  const originalYaml = "modelPresets: {hidden: {modelRoles: {default: yaml}}}\n";
  writeConfig(originalYaml, yamlPath);
  const before = await store.list();
  expect(before.configPath).toBe(configPath);
  expect(before.presets).toEqual([]);
  await store.save({ name: "new", preset: { modelRoles: { default: "alias" } }, expectedRevision: before.revision });
  expect(readFileSync(yamlPath, "utf8")).toBe(originalYaml);
});

it("reads global legacy JSONC but requires native migration before mutations", async () => {
  const legacyPath = join(agentDir, "settings.json");
  const original = `{
    // Legacy comment stays
    "theme": "dark",
    "modelRoles": {"default": "legacy-role"},
    "modelPresets": {"legacy": {"modelRoles": {"default": "legacy-alias"}}},
  }\n`;
  writeConfig(original, legacyPath);
  const before = await store.list();
  expect(before.configPath).toBe(legacyPath);
  expect(before.revision).toEqual(fileRevision(legacyPath));
  expect(before.presets).toEqual([{ name: "legacy", modelRoles: { default: "legacy-alias" } }]);
  expect(before.modelRoles).toEqual({ default: "legacy-role" });
  await expect(store.save({ name: "new", preset: { modelRoles: { default: "alias" } }, expectedRevision: before.revision })).rejects.toThrow(/legacy settings.json.*migrate/u);
  await expect(store.delete({ name: "legacy", expectedRevision: before.revision })).rejects.toThrow(/legacy settings.json.*migrate/u);
  expect(readFileSync(legacyPath, "utf8")).toBe(original);
  expect(existsSync(configPath)).toBe(false);
  expect(readdirSync(agentDir)).toEqual(["settings.json"]);
});
