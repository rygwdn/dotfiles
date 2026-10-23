import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmpServices } from "./services.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function fakeOmp() {
  const cwd = await mkdtemp(join(tmpdir(), "omp-hub-services-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const script = join(cwd, "omp.mjs");
  await writeFile(script, `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--dir") + 1];
appendFileSync(join(cwd, "calls.jsonl"), JSON.stringify(args) + "\\n");
console.error("warning: optional plugin is unavailable");
if (args[1] === "--json") {
  process.stdout.write(readFileSync(join(cwd, "list.json")));
} else if (args[1] === "logs") {
  process.stdout.write("old log\\n" + "x".repeat(70000) + "\\nnewest log\\n");
} else if (args[2] === "broken") {
  console.error("Cannot restart broken: daemon no longer exists");
  process.exitCode = 1;
} else {
  console.log("Stopped " + args[2]);
}
`);
  vi.stubEnv("BB_OMP_BRIDGE_COMMAND", process.execPath);
  vi.stubEnv("BB_OMP_BRIDGE_ARGS", JSON.stringify([script]));
  const services = createOmpServices();
  cleanups.push(() => services.dispose());
  const runtimeDir = join(cwd, "runtime");
  const daemons = [
    { name: "omp.lsp.mux", state: "ready", pid: 123, startedAt: 100, restartCount: 0, persist: true, command: "omp --lsp-mux" },
    { name: "web", state: "ready", pid: 124, startedAt: 200, readyAt: 250, readyMatch: "Listening on http://wrong-host:3333", detached: false },
    { name: "fallback", state: "ready", readyMatch: "First https://example.test:8443/path then http://other.test:9000" },
  ];
  await writeFile(join(cwd, "list.json"), JSON.stringify([
    { kind: "global", runtimeDir: join(cwd, "global"), daemons: [{ name: "other-project", state: "ready" }] },
    { kind: "project", projectDir: cwd, runtimeDir, daemons },
  ]));
  await mkdir(join(runtimeDir, "daemons", "web"), { recursive: true });
  await writeFile(join(runtimeDir, "daemons", "web", "spec.json"), JSON.stringify({
    ready: { port: 4173 },
    env: { PRIVATE_TOKEN: "never-return-this-secret" },
  }));
  return { cwd, runtimeDir, services };
}

describe("omp host services", () => {
  it("lists only project daemons, projects snapshots, and derives safe readiness addresses", async () => {
    const { cwd, services } = await fakeOmp();
    const result = await services.listOmpServices({ cwd });
    expect(result.projectDir).toBe(cwd);
    expect(result.services).toEqual([
      expect.objectContaining({ name: "omp.lsp.mux", internal: true, state: "ready", pid: 123, command: "omp --lsp-mux" }),
      expect.objectContaining({ name: "web", internal: false, url: "http://127.0.0.1:4173", port: 4173 }),
      expect.objectContaining({ name: "fallback", internal: false, url: "https://example.test:8443/path", port: 8443 }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/env|PRIVATE_TOKEN|never-return-this-secret|runtimeDir/);
  });

  it("uses the host in the ready spec and brackets IPv6 hosts", async () => {
    const { cwd, runtimeDir, services } = await fakeOmp();
    await writeFile(join(runtimeDir, "daemons", "web", "spec.json"), JSON.stringify({ ready: { port: 3000, host: "::1" } }));
    expect((await services.listOmpServices({ cwd })).services[1]).toMatchObject({ url: "http://[::1]:3000", port: 3000 });
  });

  it("shares concurrent and rapid list calls, then invalidates after a control action", async () => {
    const { cwd, services } = await fakeOmp();
    await Promise.all([services.listOmpServices({ cwd }), services.listOmpServices({ cwd })]);
    await services.listOmpServices({ cwd });
    expect((await readFile(join(cwd, "calls.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    await expect(services.controlOmpService({ cwd, name: "web", action: "stop" })).resolves.toEqual({ ok: true });
    await services.listOmpServices({ cwd });
    expect((await readFile(join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)[1])).toEqual(["--json", "stop", "--json"]);
  });

  it("returns a bounded tail of plain-text logs with the requested line count", async () => {
    const { cwd, services } = await fakeOmp();
    const { text } = await services.readOmpServiceLogs({ cwd, name: "web" });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(text).not.toContain("old log");
    expect(text).toMatch(/newest log\n$/);
    expect(JSON.parse((await readFile(join(cwd, "calls.jsonl"), "utf8")).trim())).toEqual(["ps", "logs", "web", "--dir", cwd, "-n", "200"]);
  });

  it("surfaces omp's control error instead of silently claiming success", async () => {
    const { cwd, services } = await fakeOmp();
    await expect(services.controlOmpService({ cwd, name: "broken", action: "restart" })).rejects.toThrow("Cannot restart broken: daemon no longer exists");
  });

  it("rejects option-looking names before launching omp", async () => {
    const { cwd, services } = await fakeOmp();
    await expect(services.controlOmpService({ cwd, name: "--all", action: "kill" })).rejects.toThrow("Invalid omp service name");
    await expect(services.readOmpServiceLogs({ cwd, name: "--help" })).rejects.toThrow("Invalid omp service name");
    await expect(readFile(join(cwd, "calls.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns an empty list when no project scope exists", async () => {
    const { cwd, services } = await fakeOmp();
    await writeFile(join(cwd, "list.json"), "[]");
    await expect(services.listOmpServices({ cwd })).resolves.toEqual({ projectDir: null, services: [] });
  });

  it("fails closed on invalid CLI JSON and does not cache failures", async () => {
    const { cwd, services } = await fakeOmp();
    await writeFile(join(cwd, "list.json"), "not JSON");
    await expect(services.listOmpServices({ cwd })).rejects.toThrow();
    await writeFile(join(cwd, "list.json"), "[]");
    await expect(services.listOmpServices({ cwd })).resolves.toEqual({ projectDir: null, services: [] });
  });
});
