import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

let harness: FakeOmpBridgeHarness;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-model-resolution-",
    initialize: true,
  });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

it("resolves models with the session environment at construction and on later turns", async () => {
  const modelsFile = join(harness.workspaceDir, "profile-models.json");
  const nextModelsFile = join(harness.workspaceDir, "next-profile-models.json");
  const profileModel = (id: string, contextWindow: number) => ({
    id, provider: "profile", name: id, input: ["text"], reasoning: false, contextWindow,
  });
  writeFileSync(modelsFile, JSON.stringify([
    profileModel("first", 40_000),
    profileModel("second", 80_000),
  ]));
  writeFileSync(nextModelsFile, JSON.stringify([profileModel("third", 160_000)]));
  expect((await harness.request(1, "model/list", { cwd: harness.workspaceDir })).error).toBeUndefined();
  const threadId = "thr_model_resolution_env";
  const started = await harness.startThread(threadId, {
    options: {
      ...FULL_PERMISSION_OPTIONS,
      model: "profile/first",
      envVars: { FAKE_OMP_MODELS_FILE: modelsFile },
    },
  });
  expect(started.error).toBeUndefined();
  const { providerThreadId } = z.object({ providerThreadId: z.string() }).parse(started.result);

  const changed = await harness.request(2, "turn/start", {
    threadId, providerThreadId, clientRequestId: "creq_ab23456789",
    input: [{ type: "text", text: "second model", mentions: [] }],
    options: { ...FULL_PERMISSION_OPTIONS, model: "profile/second" },
  });
  expect(changed.error).toBeUndefined();
  const seen = await harness.waitForTurnBoundary(threadId, 0);
  expect(harness.deltasOf(threadId)).toContainEqual(
    expect.objectContaining({ kind: "contextWindow", size: 80_000 }),
  );

  const changedEnvironment = await harness.request(3, "turn/start", {
    threadId, providerThreadId, clientRequestId: "creq_bc23456789",
    input: [{ type: "text", text: "third model", mentions: [] }],
    options: {
      ...FULL_PERMISSION_OPTIONS,
      model: "profile/third",
      envVars: { FAKE_OMP_MODELS_FILE: nextModelsFile },
    },
  });
  expect(changedEnvironment.error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, seen);
  expect(harness.deltasOf(threadId)).toContainEqual(
    expect.objectContaining({ kind: "contextWindow", size: 160_000 }),
  );
}, 60_000);

for (const warm of [false, true]) {
  it.each([
    ["fake-gateway/vendor/slash-model", 64_000],
    ["vendor/slash-model", 64_000],
    ["fake-provider/fake-model", 200_000],
    ["fake-gateway/vendor/shared-model", 64_000],
  ])(
    `starts the exact model %s with a ${warm ? "warm" : "cold"} catalog`,
    async (model, contextWindow) => {
      if (warm) {
        const catalog = await harness.request(1, "model/list", {
          cwd: harness.workspaceDir,
        });
        expect(catalog.error).toBeUndefined();
      }
      const threadId = "thr_model_resolution";
      const response = await harness.startThread(threadId, {
        options: { ...FULL_PERMISSION_OPTIONS, model },
      });
      expect(response.error, JSON.stringify(response)).toBeUndefined();
      const { providerThreadId } = z
        .object({ providerThreadId: z.string() })
        .parse(response.result);
      const turn = await harness.request(2, "turn/start", {
        threadId,
        providerThreadId,
        clientRequestId: "creq_ab23456789",
        input: [{ type: "text", text: "hello", mentions: [] }],
        options: { ...FULL_PERMISSION_OPTIONS, model },
      });
      expect(turn.error, JSON.stringify(turn)).toBeUndefined();
      await harness.waitForTurnBoundary(threadId, 0);
      expect(harness.deltasOf(threadId)).toContainEqual(
        expect.objectContaining({ kind: "contextWindow", size: contextWindow }),
      );
    },
    60_000,
  );

  it.each([
    ["vendor/shared-model", "Ambiguous OMP model"],
    ["fake-provider/missing", "Failed to resolve OMP model"],
    ["unknown/missing", "Failed to resolve OMP model"],
  ])(
    `rejects %s during resolution with a ${warm ? "warm" : "cold"} catalog`,
    async (model, message) => {
      if (warm) {
        const catalog = await harness.request(1, "model/list", {
          cwd: harness.workspaceDir,
        });
        expect(catalog.error).toBeUndefined();
      }
      const response = await harness.startThread("thr_model_resolution", {
        options: { ...FULL_PERMISSION_OPTIONS, model },
      });
      expect(response.error).toMatchObject({
        message: expect.stringContaining(message),
      });
    },
    60_000,
  );
}
