import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import entry from "./host.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "bi11-host-overlay-"));
  directories.push(dataDir);
  return { dataDir, prepare: () => entry.handlers.prepareOmpMemoryOverlay(null,
    { experimental_paths: { dataDir } } as never) };
}

it("preserves inherited overlay order and appends suppression on the execution host", async () => {
  const { dataDir, prepare } = await fixture();
  const overlay = join(dataDir, "bb-memory-overlay.json");
  const first = join(dataDir, "caller one.yml");
  const second = join(dataDir, "caller-two.yml");
  vi.stubEnv("PI_CONFIG_FILES", [first, overlay, second].join(delimiter));
  const result = await prepare();
  expect(result.configFiles.split(delimiter)).toEqual([first, second, overlay]);
  expect(JSON.parse(await readFile(overlay, "utf8"))).toEqual({
    memory: { backend: "off" }, autolearn: { autoContinue: false },
  });
  expect(process.env.PI_CONFIG_FILES).toBe([first, overlay, second].join(delimiter));
});

it("never publishes a truncated overlay while concurrent launches prepare it", async () => {
  const { dataDir, prepare } = await fixture();
  vi.stubEnv("PI_CONFIG_FILES", "");
  await prepare();
  const writes = Promise.all(Array.from({ length: 32 }, prepare));
  for (let read = 0; read < 64; read++) {
    expect(JSON.parse(await readFile(join(dataDir, "bb-memory-overlay.json"), "utf8")))
      .toEqual({ memory: { backend: "off" }, autolearn: { autoContinue: false } });
  }
  await writes;
  expect(await readdir(dataDir)).toEqual(["bb-memory-overlay.json"]);
});
