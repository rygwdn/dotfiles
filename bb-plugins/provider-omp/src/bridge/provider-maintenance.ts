import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ProviderHealthResult,
  type ProviderInstallationCommand,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_compareVersions as compareVersions,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_resolveExecutablePath as resolveExecutablePath,
} from "@get-bb/plugin-sdk/provider-bridge";
import { resolveOmpLaunch } from "./rpc-child.js";

const execFileAsync = promisify(execFile);
export const OMP_MINIMUM_SUPPORTED_VERSION = "18.10.0";
const OMP_INSTALL_URL = "https://omp.sh/install";
const OMP_INSTALL_DOCS = "https://github.com/can1357/oh-my-pi#install";
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const INSTALL_GATE_TTL_MS = 30_000;

type OmpVersionProbe =
  | { version: string; failure: null }
  | { version: null; failure: string };

function ompInstallCommand(): ProviderInstallationCommand {
  return downloadedInstallerCommand(OMP_INSTALL_URL, {
    powershellUrl: "https://omp.sh/install.ps1",
  });
}

function ompUpdateCommand(): ProviderInstallationCommand {
  const launch = resolveOmpLaunch(process.env);
  const args = [...launch.args, "update"];
  return {
    command: launch.command,
    args,
    displayCommand: formatCommand(launch.command, args),
  };
}

export async function probeOmpVersion(): Promise<OmpVersionProbe> {
  const launch = resolveOmpLaunch(process.env);
  const display = formatCommand(launch.command, [...launch.args, "--version"]);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      launch.command,
      [...launch.args, "--version"],
      {
        timeout: VERSION_PROBE_TIMEOUT_MS,
      },
    ));
  } catch (error) {
    return {
      version: null,
      failure: `\`${display}\` ${describeOmpVersionProbeFailure(error)}`,
    };
  }
  const version =
    stdout.match(/^omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/mu)?.[1] ?? null;
  return version === null
    ? { version: null, failure: `\`${display}\` printed no version` }
    : { version, failure: null };
}

export function describeOmpVersionProbeFailure(error: unknown): string {
  const failed =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown; killed?: unknown; signal?: unknown })
      : null;
  if (failed?.killed === true) {
    return `timed out after ${VERSION_PROBE_TIMEOUT_MS / 1000} s`;
  }
  if (typeof failed?.signal === "string") {
    return `was stopped by ${failed.signal} before it answered`;
  }
  if (failed?.code !== undefined && failed.code !== null) {
    return `exited with ${String(failed.code)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function getOmpProviderInstallationStatus(
  checkUpdates = true,
): Promise<ProviderInstallationStatus> {
  const launch = resolveOmpLaunch(process.env);
  const [resolvedExecutable, probe] = await Promise.all([
    resolveExecutablePath(launch.command),
    probeOmpVersion(),
  ]);
  const currentVersion = probe.version;
  const installed = resolvedExecutable !== null || currentVersion !== null;
  const versionUnsupported =
    installed &&
    currentVersion !== null &&
    compareVersions(currentVersion, OMP_MINIMUM_SUPPORTED_VERSION) < 0;
  const actionKind = installed ? "update" : "install";
  const installAction: ProviderInstallationStatus["installAction"] =
    !checkUpdates
      ? null
      : {
          kind: actionKind,
          label: actionKind === "install" ? "Install" : "Update",
          command: (installed ? ompUpdateCommand() : ompInstallCommand())
            .displayCommand,
        };

  return {
    executableName: "omp",
    executablePath: resolvedExecutable,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion: null,
    minimumSupportedVersion: OMP_MINIMUM_SUPPORTED_VERSION,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction,
    needsUpdate: versionUnsupported,
    versionUnsupported,
  };
}

export async function getOmpProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getOmpProviderInstallationStatus();
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `OMP ${action} is no longer available on this host.`,
    };
  }
  return {
    available: true,
    command: action === "install" ? ompInstallCommand() : ompUpdateCommand(),
    verification: installationVerification(status, action),
  };
}

export function ompHealthResult(
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "unsupported_version"
    | "unknown",
  args: {
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: OMP_MINIMUM_SUPPORTED_VERSION,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: "omp",
    },
  };
}

export type OmpInstallGate =
  | { ok: true; installedVersion: string }
  | {
      ok: false;
      status: "not_installed" | "unsupported_version" | "unknown";
      statusMessage: string | null;
      result: ProviderHealthResult;
    };

const INSTALL_GUIDANCE = `Install OMP ${OMP_MINIMUM_SUPPORTED_VERSION} or newer from ${OMP_INSTALL_DOCS}; run \`omp update\` to upgrade an existing installation.`;

async function probeOmpInstallGate(): Promise<OmpInstallGate> {
  const launch = resolveOmpLaunch(process.env);
  if ((await resolveExecutablePath(launch.command)) === null) {
    return {
      ok: false,
      status: "not_installed",
      statusMessage: INSTALL_GUIDANCE,
      result: ompHealthResult("not_installed", { statusMessage: INSTALL_GUIDANCE }),
    };
  }
  const probe = await probeOmpVersion();
  if (probe.version === null) {
    const statusMessage = `Could not determine the omp version: ${probe.failure}. ${INSTALL_GUIDANCE}`;
    return {
      ok: false,
      status: "unknown",
      statusMessage,
      result: ompHealthResult("unknown", { statusMessage }),
    };
  }
  const installedVersion = probe.version;
  if (compareVersions(installedVersion, OMP_MINIMUM_SUPPORTED_VERSION) < 0) {
    const statusMessage = `OMP ${installedVersion} is older than the supported minimum ${OMP_MINIMUM_SUPPORTED_VERSION}. ${INSTALL_GUIDANCE}`;
    return {
      ok: false,
      status: "unsupported_version",
      statusMessage,
      result: ompHealthResult("unsupported_version", {
        installedVersion,
        statusMessage,
      }),
    };
  }
  return { ok: true, installedVersion };
}

const installGateMemo = new Map<
  string,
  { expiresAt: number; gate: Promise<OmpInstallGate> }
>();

export function getOmpInstallGate(): Promise<OmpInstallGate> {
  const launch = resolveOmpLaunch(process.env);
  const key = JSON.stringify([launch.command, launch.args]);
  const now = Date.now();
  const cached = installGateMemo.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.gate;
  }
  const gate = probeOmpInstallGate();
  installGateMemo.set(key, { expiresAt: now + INSTALL_GATE_TTL_MS, gate });
  gate.catch(() => {
    if (installGateMemo.get(key)?.gate === gate) installGateMemo.delete(key);
  });
  return gate;
}

export function resetOmpInstallGateForTests(): void {
  installGateMemo.clear();
}
