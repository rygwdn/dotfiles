import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const TIMEOUT_MS = 60_000;
const modelSchema = z.object({
  id: z.string(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string(),
});
const modelListSchema = z.object({
  models: z.array(modelSchema),
  selectedOnlyModels: z.array(modelSchema),
});
const launchSchema = z.object({
  args: z.array(z.string()),
  marker: z.string().nullable(),
});
const nativeModel = (id: string) => ({
  id,
  provider: "env-provider",
  name: id,
  input: ["text"],
  reasoning: false,
  contextWindow: 64_000,
});

let harness: FakeOmpBridgeHarness;
let launchLog: string;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-model-list-env-",
    initialize: true,
  });
  const agentDir = join(harness.workspaceDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("HOME", harness.workspaceDir);
  vi.stubEnv("OMP_PROFILE", undefined);
  vi.stubEnv("PI_PROFILE", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CONFIG_FILES", undefined);
  vi.stubEnv("FAKE_OMP_MODELS_FILE", writeModels("inherited", ["inherited"]));
  vi.stubEnv("FAKE_OMP_STATE_MODEL", JSON.stringify(nativeModel("inherited")));
  vi.stubEnv("FAKE_OMP_ENV_MARKER", undefined);
  launchLog = join(harness.workspaceDir, "launches.jsonl");
  vi.stubEnv("FAKE_OMP_LAUNCH_LOG", launchLog);
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function writeModels(name: string, ids: string[]): string {
  const path = join(harness.workspaceDir, `${name}-models.json`);
  writeFileSync(path, JSON.stringify(ids.map(nativeModel)));
  return path;
}

async function listModels(
  id: number,
  envVars?: Record<string, string>,
  modelPresetsInPicker?: "both" | "presets",
) {
  const response = await harness.request(id, "model/list", {
    cwd: harness.workspaceDir,
    ...(envVars === undefined ? {} : { envVars }),
    ...(modelPresetsInPicker === undefined ? {} : {
      providerOptions: { modelFilter: { modelPresetsInPicker } },
    }),
  });
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  return modelListSchema.parse(response.result);
}

function launches() {
  return readFileSync(launchLog, "utf8").trim().split("\n")
    .map((line) => launchSchema.parse(JSON.parse(line)));
}

it("isolates model/list catalogs and native defaults by envVars while sharing reordered keys", async () => {
  const alphaEnv = {
    FAKE_OMP_MODELS_FILE: writeModels("alpha", ["alpha-first", "alpha-active"]),
    FAKE_OMP_STATE_MODEL: JSON.stringify(nativeModel("alpha-active")),
    FAKE_OMP_ENV_MARKER: "alpha",
  };
  const betaEnv = {
    FAKE_OMP_MODELS_FILE: writeModels("beta", ["beta-active"]),
    FAKE_OMP_STATE_MODEL: JSON.stringify(nativeModel("beta-active")),
    FAKE_OMP_ENV_MARKER: "beta",
  };
  const inherited = await listModels(1);
  expect(inherited.models.map((model) => model.id)).toEqual(["env-provider/inherited"]);

  const alpha = await listModels(2, alphaEnv);
  expect(alpha.models.map((model) => model.id)).toEqual([
    "env-provider/alpha-active", "env-provider/alpha-first",
  ]);
  expect(alpha.models.filter((model) => model.isDefault).map((model) => model.id))
    .toEqual(["env-provider/alpha-active"]);

  const beta = await listModels(3, betaEnv);
  expect(beta.models.map((model) => model.id)).toEqual(["env-provider/beta-active"]);
  expect(beta.models[0]?.isDefault).toBe(true);
  expect(await listModels(4)).toEqual(inherited);
  expect(await listModels(5, Object.fromEntries(Object.entries(alphaEnv).reverse()))).toEqual(alpha);
  expect(await listModels(6, betaEnv)).toEqual(beta);

  // Reordered override keys reuse the same native child rather than a second catalog.
  expect(launches()).toEqual([
    { args: ["--mode", "rpc", "--cwd", harness.workspaceDir, "--no-session"], marker: null },
    { args: ["--mode", "rpc", "--cwd", harness.workspaceDir, "--no-session"], marker: "alpha" },
    { args: ["--mode", "rpc", "--cwd", harness.workspaceDir, "--no-session"], marker: "beta" },
  ]);
  expect(process.env.FAKE_OMP_STATE_MODEL).toBe(JSON.stringify(nativeModel("inherited")));
}, TIMEOUT_MS);

it("resolves environment-scoped agent and overlay presets with their effective default", async () => {
  const modelsPath = writeModels("presets", ["first", "second"]);
  function presetEnv(name: string, defaultId: string): Record<string, string> {
    const agentDir = join(harness.workspaceDir, `${name}-agent`);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "config.yml"), JSON.stringify({
      modelRoles: { default: "env-provider/first" },
      modelPresets: {
        [`${name}_base`]: { modelRoles: { default: "env-provider/first" } },
      },
    }));
    const overlayPath = join(harness.workspaceDir, `${name}-overlay.yml`);
    writeFileSync(overlayPath, JSON.stringify({
      modelRoles: { default: `env-provider/${defaultId}` },
      modelPresets: {
        [`${name}_selected`]: {
          modelRoles: { default: `env-provider/${defaultId}` },
          defaultThinkingLevel: "low",
        },
      },
    }));
    return {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CONFIG_FILES: overlayPath,
      FAKE_OMP_MODELS_FILE: modelsPath,
    };
  }
  const alphaEnv = presetEnv("alpha", "second");
  const betaEnv = presetEnv("beta", "second");
  const inherited = await listModels(1, undefined, "presets");
  expect(inherited.models.map((model) => model.id)).toEqual(["env-provider/inherited"]);

  const alpha = await listModels(2, alphaEnv, "presets");
  expect(alpha.models).toEqual([
    { id: "preset:alpha_selected", isDefault: true, defaultReasoningEffort: "low" },
    { id: "preset:alpha_base", isDefault: false, defaultReasoningEffort: "medium" },
  ]);
  expect(alpha.selectedOnlyModels.map((model) => model.id)).toEqual([
    "env-provider/first", "env-provider/second",
  ]);
  const beta = await listModels(3, betaEnv, "presets");
  expect(beta.models).toEqual([
    { id: "preset:beta_selected", isDefault: true, defaultReasoningEffort: "low" },
    { id: "preset:beta_base", isDefault: false, defaultReasoningEffort: "medium" },
  ]);
  expect(await listModels(4, alphaEnv, "presets")).toEqual(alpha);
  expect(await listModels(5, undefined, "presets")).toEqual(inherited);
}, TIMEOUT_MS);

it("rejects non-string model/list envVars at the bridge boundary", async () => {
  const response = await harness.request(1, "model/list", {
    cwd: harness.workspaceDir,
    envVars: { FAKE_OMP_MODELS_FILE: 123 },
  });
  expect(response.error).toMatchObject({ code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS });
  expect(response.result).toBeUndefined();
}, TIMEOUT_MS);
