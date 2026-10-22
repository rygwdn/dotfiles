import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OMP_BRIDGE_ARGS_ENV, OMP_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import {
  getOmpInstallGate,
  getOmpProviderInstallationStatus,
  getOmpProviderInstallationRun,
  probeOmpVersion,
  resetOmpInstallGateForTests,
} from "./provider-maintenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetOmpInstallGateForTests();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function configureNodeProbe(script: string): void {
  vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, process.execPath);
  vi.stubEnv(OMP_BRIDGE_ARGS_ENV, JSON.stringify(["-e", script, "--"]));
}

describe("OMP version probe", () => {
  it("preserves configured launch arguments and ignores stderr warnings", async () => {
    configureNodeProbe(
      'if (process.argv[1] !== "--version") process.exit(2); process.stderr.write("Warning: plugin warning\\n"); process.stdout.write("omp/18.10.4\\n");',
    );
    expect(await probeOmpVersion()).toEqual({
      version: "18.10.4",
      failure: null,
    });
    expect(await getOmpInstallGate()).toEqual({
      ok: true,
      installedVersion: "18.10.4",
    });
  });

  it("reports a non-zero exit even when stdout contains a version", async () => {
    configureNodeProbe('process.stdout.write("omp/18.10.4\\n"); process.exit(2);');
    expect(await probeOmpVersion()).toMatchObject({
      version: null,
      failure: expect.stringContaining("exited with 2"),
    });
  });

  it("does not interpret stderr as a successful version response", async () => {
    configureNodeProbe('process.stderr.write("omp/18.10.4\\n");');
    expect(await probeOmpVersion()).toMatchObject({
      version: null,
      failure: expect.stringContaining("printed no version"),
    });
  });

  // execFile's child-process deadline uses the platform clock, not Vitest timers.
  it("retains the 15 s timeout even when the child prints a version", async () => {
    configureNodeProbe(
      'process.stdout.write("omp/18.10.4\\n"); setInterval(() => {}, 1000);',
    );
    expect(await probeOmpVersion()).toMatchObject({
      version: null,
      failure: expect.stringContaining("timed out after 15 s"),
    });
  }, 25_000);

  it("reports a missing executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-omp-missing-"));
    temporaryDirectories.push(root);
    vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, path.join(root, "missing-omp"));
    vi.stubEnv(OMP_BRIDGE_ARGS_ENV, "[]");
    expect(await probeOmpVersion()).toMatchObject({
      version: null,
      failure: expect.stringContaining("exited with ENOENT"),
    });
  });

  it("rejects a bare Pi version rather than accepting a different provider", async () => {
    configureNodeProbe('process.stdout.write("0.84.0\\n");');
    expect(await probeOmpVersion()).toMatchObject({
      version: null,
      failure: expect.stringContaining("printed no version"),
    });
  });

  it("rejects OMP versions below 18.10.0 with native upgrade guidance", async () => {
    configureNodeProbe('process.stdout.write("omp/18.9.9\\n");');
    expect(await getOmpInstallGate()).toMatchObject({
      ok: false,
      status: "unsupported_version",
      statusMessage: expect.stringContaining("omp update"),
    });
    expect(await getOmpProviderInstallationStatus()).toMatchObject({
      currentVersion: "18.9.9",
      minimumSupportedVersion: "18.10.0",
      needsUpdate: true,
      versionUnsupported: true,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      installSource: "external",
      installAction: { kind: "update" },
    });
    expect(await getOmpProviderInstallationRun("update")).toMatchObject({
      available: true,
      command: {
        command: process.execPath,
        args: [...JSON.parse(process.env[OMP_BRIDGE_ARGS_ENV] ?? "[]"), "update"],
      },
    });
  });

  it("offers the native updater without inventing a latest release", async () => {
    configureNodeProbe('process.stdout.write("omp/18.10.4\\n");');
    expect(await getOmpProviderInstallationStatus()).toMatchObject({
      currentVersion: "18.10.4",
      latestVersion: null,
      needsUpdate: false,
      versionUnsupported: false,
      installAction: { kind: "update" },
    });
    expect(await getOmpProviderInstallationStatus(false)).toMatchObject({
      currentVersion: "18.10.4",
      installAction: null,
    });
    expect(await getOmpProviderInstallationRun("install")).toMatchObject({
      available: false,
    });
  });

  it("offers the official OMP installer when the executable is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-omp-installer-"));
    temporaryDirectories.push(root);
    vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, path.join(root, "missing-omp"));
    vi.stubEnv(OMP_BRIDGE_ARGS_ENV, "[]");
    const status = await getOmpProviderInstallationStatus();
    expect(status).toMatchObject({
      installed: false,
      installSource: "notInstalled",
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      installAction: {
        kind: "install",
        command: expect.stringContaining("https://omp.sh/install"),
      },
    });
    expect(await getOmpProviderInstallationRun("install")).toMatchObject({
      available: true,
      command: {
        displayCommand: status.installAction?.command,
      },
      verification: { kind: "installed" },
    });
  });
});
