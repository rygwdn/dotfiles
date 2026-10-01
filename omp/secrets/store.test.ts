import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { command, initialize, load, type StoreConfig } from "./store";

let directory: string;
let cfg: StoreConfig;
let publicKey: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omp-secret-test-"));
  cfg = { host: "proxmox", store: "/unused", identity: join(directory, "keys/identity.txt"), cache: join(directory, "cache/store.age"), offline: true };
  await initialize(cfg);
  publicKey = (await command("age-keygen", ["-y", cfg.identity])).toString().trim();
  await mkdir(dirname(cfg.cache), { mode: 0o700 });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function snapshot(value: unknown): Promise<void> {
  const ciphertext = await command("age", ["--recipient", publicKey], Buffer.from(JSON.stringify(value)));
  await writeFile(cfg.cache, ciphertext, { mode: 0o600 });
}

test("offline values preserve shell-sensitive and multiline bytes without plaintext persistence", async () => {
  const value = "quote'\"$`\\\nsecond-line-secret";
  await snapshot({ homelab: { bookorbit: { api_key: value } }, EXAMPLE_TOKEN: "ignored" });
  const result = await load(cfg);
  expect(result.values).toEqual({ OMP_SECRET_HOMELAB_BOOKORBIT_API_KEY: value });
  expect(result.catalog).toMatchObject({ source: "cache", entries: [{ path: "homelab/bookorbit/api_key", env: "OMP_SECRET_HOMELAB_BOOKORBIT_API_KEY" }] });
  expect((await readFile(cfg.cache)).includes(Buffer.from(value))).toBe(false);
  expect(JSON.stringify(result.catalog)).not.toContain(value);
});

test("normalized path collisions fail rather than silently selecting a credential", async () => {
  await snapshot({ "api-key": "first-token", api_key: "other-token" });
  await expect(load(cfg)).rejects.toThrow("collide");
});

test("values OMP cannot auto-redact fail before entering a command environment", async () => {
  await snapshot({ PASSWORD: "short" });
  await expect(load(cfg)).rejects.toThrow("at least 8");
  await snapshot({ TOKEN: "valid-key\0invalid" });
  await expect(load(cfg)).rejects.toThrow("NUL-free");
});

test("corrupt ciphertext and missing caches do not yield credentials", async () => {
  await writeFile(cfg.cache, "not an age message");
  await expect(load(cfg)).rejects.toThrow("age failed");
  await rm(cfg.cache);
  await expect(load(cfg)).rejects.toThrow("no encrypted offline cache");
});

test("initialization preserves the existing offline identity and rejects public-readable keys", async () => {
  const before = await readFile(cfg.identity);
  await initialize(cfg);
  expect(await readFile(cfg.identity)).toEqual(before);
  await chmod(cfg.identity, 0o644);
  await expect(load(cfg)).rejects.toThrow("owner-only");
});

test("misconfigured paths cannot overwrite the identity or change an unrelated directory", async () => {
  await expect(load({ ...cfg, cache: cfg.identity })).rejects.toThrow("different files");
  await expect(initialize({ ...cfg, identity: "relative-key.txt" })).rejects.toThrow("absolute");
});
