import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeAllOmpCatalogs, getOmpCatalog, peekOmpCatalog } from "./catalog.js";
import { DEFAULT_OMP_MODEL_FILTER } from "../model-curation.js";
import { OMP_BRIDGE_ARGS_ENV, OMP_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { fakeOmpPath } from "./test-support.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

const FAKE_MODEL = {
  id: "fake-model",
  name: "Fake Model",
  provider: "fake-provider",
  input: ["text"],
  reasoning: true,
  thinking: {
    mode: "effort",
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  contextWindow: 200_000,
};
const ADDED_MODEL = {
  id: "added-model",
  name: "Added Model",
  provider: "added-provider",
  input: ["text"],
  reasoning: false,
  contextWindow: 64_000,
};

afterEach(async () => {
  await closeAllOmpCatalogs();
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setUpFakeCatalog(env: Record<string, string> = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "bb-omp-catalog-"));
  tempDirs.push(workspace);
  const paths = {
    workspace,
    modelsPath: join(workspace, "models.json"),
    spawnCounterPath: join(workspace, "spawns.txt"),
    processLogPath: join(workspace, "processes.txt"),
    launchLogPath: join(workspace, "launches.jsonl"),
  };
  writeFileSync(paths.modelsPath, JSON.stringify([FAKE_MODEL]));
  process.env[OMP_BRIDGE_COMMAND_ENV] = process.execPath;
  process.env[OMP_BRIDGE_ARGS_ENV] = JSON.stringify([fakeOmpPath]);
  process.env.FAKE_OMP_MODELS_FILE = paths.modelsPath;
  process.env.FAKE_OMP_SPAWN_COUNTER_FILE = paths.spawnCounterPath;
  process.env.FAKE_OMP_PROCESS_LOG = paths.processLogPath;
  process.env.FAKE_OMP_LAUNCH_LOG = paths.launchLogPath;
  // Keep the user's real omp config (roles, presets) out of the listed models.
  process.env.HOME = workspace;
  Object.assign(process.env, env);
  return paths;
}

describe("native omp catalog", () => {
  it("keeps explicit cwd and isolates catalogs by unordered environment overrides", async () => {
    const paths = setUpFakeCatalog();
    const alternateModels = join(paths.workspace, "alternate-models.json");
    writeFileSync(alternateModels, JSON.stringify([ADDED_MODEL]));
    const overrides = {
      FAKE_OMP_MODELS_FILE: alternateModels,
      FAKE_OMP_ENV_MARKER: "profile",
    };
    const defaultCatalog = await getOmpCatalog(paths.workspace);
    expect(await getOmpCatalog(paths.workspace, { BB_THREAD_ID: "thread-one" })).toBe(defaultCatalog);
    const profilePromise = getOmpCatalog(paths.workspace, overrides);
    expect(getOmpCatalog(paths.workspace, {
      FAKE_OMP_ENV_MARKER: "profile",
      FAKE_OMP_MODELS_FILE: alternateModels,
    })).toBe(profilePromise);
    expect(peekOmpCatalog(paths.workspace, overrides)).toBe(profilePromise);
    expect(getOmpCatalog(paths.workspace, { ...overrides, BB_THREAD_ID: "thread-two" })).toBe(profilePromise);
    expect(peekOmpCatalog(paths.workspace, { ...overrides, BB_THREAD_ID: "thread-three" })).toBe(profilePromise);
    expect(getOmpCatalog(paths.workspace, {
      ...overrides,
      BB_CONTINUITY_DIRECTORY: "/thread-one/continuity",
      BB_CONTINUITY_EXTENSION: "/thread-one/extension.mjs",
    })).toBe(profilePromise);
    expect(peekOmpCatalog(paths.workspace, {
      ...overrides,
      BB_CONTINUITY_DIRECTORY: "/thread-two/continuity",
      BB_CONTINUITY_EXTENSION: "/thread-two/extension.mjs",
    })).toBe(profilePromise);
    const profileCatalog = await profilePromise;
    expect(profileCatalog).not.toBe(defaultCatalog);
    expect(await defaultCatalog.rawModels()).toEqual([FAKE_MODEL]);
    expect(await profileCatalog.rawModels()).toEqual([ADDED_MODEL]);
    expect(await defaultCatalog.rawModels()).toEqual([FAKE_MODEL]);

    const launches = readFileSync(paths.launchLogPath, "utf8").trim().split("\n")
      .map((line) => z.object({
        args: z.array(z.string()),
        marker: z.string().nullable(),
      }).parse(JSON.parse(line)));
    expect(launches).toEqual([
      { args: ["--mode", "rpc", "--cwd", paths.workspace, "--no-session"], marker: null },
      { args: ["--mode", "rpc", "--cwd", paths.workspace, "--no-session"], marker: "profile" },
    ]);
  }, 60_000);

  it("maps native thinking efforts and keeps OMP's active model as default", async () => {
    const paths = setUpFakeCatalog({
      FAKE_OMP_STATE_MODEL: JSON.stringify(ADDED_MODEL),
    });
    writeFileSync(paths.modelsPath, JSON.stringify([
      { ...FAKE_MODEL, serviceTiers: ["priority"], kind: "chat" },
      ADDED_MODEL,
      { ...FAKE_MODEL, id: "specialist", kind: "embedding" },
    ]));

    const catalog = await getOmpCatalog(paths.workspace);
    const { models, selectedOnlyModels } = await catalog.listModels(DEFAULT_OMP_MODEL_FILTER);

    expect(models.map((model) => model.id)).toEqual([
      "added-provider/added-model",
      "fake-provider/fake-model",
    ]);
    expect(
      models[1]?.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(models[1]?.defaultReasoningEffort).toBe("medium");
    expect(selectedOnlyModels.map(({ id }) => id)).toEqual(["fake-provider/specialist"]);
    // omp's /fast owns fast mode, so even a priority-capable model gets no Fast switch.
    for (const model of models) {
      expect(model.supportedServiceTiers).toBeUndefined();
      expect(model.sessionOptions).toBeUndefined();
    }
    expect(models[0]).toMatchObject({
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "none" }],
      defaultReasoningEffort: "none",
    });
    expect(await catalog.probe()).toMatchObject({ model: ADDED_MODEL });
  }, 60_000);

  it("rereads native models without respawning a live child", async () => {
    const paths = setUpFakeCatalog();
    const catalog = await getOmpCatalog(paths.workspace);
    expect((await catalog.listModels(DEFAULT_OMP_MODEL_FILTER)).models.map((model) => model.id)).toEqual([
      "fake-provider/fake-model",
    ]);

    writeFileSync(paths.modelsPath, JSON.stringify([FAKE_MODEL, ADDED_MODEL]));

    expect((await catalog.listModels(DEFAULT_OMP_MODEL_FILTER)).models.map((model) => model.id)).toEqual([
      "fake-provider/fake-model",
      "added-provider/added-model",
    ]);
    expect(readFileSync(paths.spawnCounterPath, "utf8")).toBe("1");
  }, 60_000);

  it("serves concurrent list and raw reads from the current catalog", async () => {
    const paths = setUpFakeCatalog();
    const catalog = await getOmpCatalog(paths.workspace);
    await catalog.listModels(DEFAULT_OMP_MODEL_FILTER);
    writeFileSync(paths.modelsPath, JSON.stringify([FAKE_MODEL, ADDED_MODEL]));

    const [listed, raw] = await Promise.all([
      catalog.listModels(DEFAULT_OMP_MODEL_FILTER),
      catalog.rawModels(),
    ]);

    expect(listed.models.map((model) => model.id)).toContain(
      "added-provider/added-model",
    );
    expect(raw).toEqual([FAKE_MODEL, ADDED_MODEL]);
    expect(readFileSync(paths.spawnCounterPath, "utf8")).toBe("1");
  }, 60_000);

  it("replaces an exited child and reads the new native catalog", async () => {
    const paths = setUpFakeCatalog({ FAKE_OMP_EXIT_AFTER_FIRST_AVAILABLE: "1" });
    const catalog = await getOmpCatalog(paths.workspace);
    expect((await catalog.listModels(DEFAULT_OMP_MODEL_FILTER)).models[0]?.id).toBe(
      "fake-provider/fake-model",
    );
    await vi.waitFor(() => {
      expect(readFileSync(paths.processLogPath, "utf8")).toContain("exit:");
    });
    writeFileSync(paths.modelsPath, JSON.stringify([ADDED_MODEL]));

    const second = await catalog.listModels(DEFAULT_OMP_MODEL_FILTER);

    expect(second.models.map((model) => model.id)).toEqual([
      "added-provider/added-model",
    ]);
    expect(second.models[0]?.isDefault).toBe(true);
    expect(readFileSync(paths.spawnCounterPath, "utf8")).toBe("2");
  }, 60_000);

  it("ignores incomplete models while preserving usable catalog entries", async () => {
    const paths = setUpFakeCatalog();
    writeFileSync(
      paths.modelsPath,
      JSON.stringify([
        { id: "missing-provider" },
        { provider: "missing-id" },
        null,
        FAKE_MODEL,
      ]),
    );
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const catalog = await getOmpCatalog(paths.workspace);
      const { models } = await catalog.listModels(DEFAULT_OMP_MODEL_FILTER);
      expect(models.map((model) => model.id)).toEqual([
        "fake-provider/fake-model",
      ]);
    } finally {
      warning.mockRestore();
    }
  }, 60_000);

  it("closes idle catalog children", async () => {
    const paths = setUpFakeCatalog({ BB_OMP_CATALOG_IDLE_MS: "100" });
    const catalog = await getOmpCatalog(paths.workspace);
    await catalog.listModels(DEFAULT_OMP_MODEL_FILTER);

    await vi.waitFor(() => {
      expect(existsSync(paths.processLogPath)).toBe(true);
      expect(readFileSync(paths.processLogPath, "utf8")).toContain("exit:");
    });
  }, 60_000);
});
