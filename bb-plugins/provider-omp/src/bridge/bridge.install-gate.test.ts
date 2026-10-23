import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OMP_BRIDGE_ARGS_ENV, OMP_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import {
  type FakeOmpBridgeHarness,
  fakeOmpPath,
  startFakeOmpBridge,
} from "./test-support.js";

let harness: FakeOmpBridgeHarness;
let requestId = 0;

function nextRequestId(): number {
  requestId += 1;
  return requestId;
}

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-install-gate-",
    initialize: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("reports ready with the installed version after the get_state probe", async () => {
  const response = await harness.request(nextRequestId(), "provider/health", {
    providerId: "omp",
    cwd: harness.workspaceDir,
  });
  expect(response.result).toMatchObject({
    supported: true,
    health: {
      status: "ready",
      installedVersion: "18.10.4",
      minimumSupportedVersion: "18.10.0",
      canInstall: true,
      canUpdate: true,
      loginCommand: "omp",
    },
  });
}, 30_000);

it("refuses OMP older than the supported minimum before spawning a session", async () => {
  vi.stubEnv("FAKE_OMP_VERSION", "18.9.9");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "omp",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: { status: "unsupported_version", installedVersion: "18.9.9" },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    message: expect.stringContaining(
      "18.9.9 is older than the supported minimum 18.10.0",
    ),
  });
});

it("reports not_installed when the launch command is missing", async () => {
  vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, join(harness.workspaceDir, "no-such-omp"));
  vi.stubEnv(OMP_BRIDGE_ARGS_ENV, "[]");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "omp",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: { status: "not_installed", canInstall: true, canUpdate: false },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    code: BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
    message: expect.stringContaining("Could not find the omp CLI"),
  });
});

it("fails closed when omp cannot report its version, with install guidance", async () => {
  vi.stubEnv("FAKE_OMP_VERSION", "crash");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "omp",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: {
      status: "unknown",
      installedVersion: null,
      statusMessage: expect.stringContaining(
        "Install OMP 18.10.0 or newer from https://github.com/can1357/oh-my-pi#install",
      ),
    },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    message: expect.stringContaining("Could not determine the omp version"),
  });
});

it("memoizes the install gate per launch path across health polls", async () => {
  const processLog = join(harness.workspaceDir, "process.log");
  vi.stubEnv("FAKE_OMP_PROCESS_LOG", processLog);
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "omp",
    cwd: harness.workspaceDir,
  });
  await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "omp",
    cwd: harness.workspaceDir,
  });
  const versionSpawns = readFileSync(processLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("version:"));
  expect(versionSpawns).toHaveLength(1);
  vi.stubEnv(
    OMP_BRIDGE_ARGS_ENV,
    JSON.stringify([fakeOmpPath, "--other-launch"]),
  );
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "omp",
    cwd: harness.workspaceDir,
  });
  expect(
    readFileSync(processLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("version:")),
  ).toHaveLength(2);
}, 30_000);
