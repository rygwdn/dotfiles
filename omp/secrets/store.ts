import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoreConfig { host: string; store: string; identity: string; cache: string; offline: boolean }
export interface Entry { path: string; env: string }
export interface LoadedStore { values: Record<string, string>; catalog: { source: "remote" | "cache"; cachedAt: string; entries: Entry[] } }

export function config(): StoreConfig {
  return {
    host: process.env.OMP_SECRETS_HOST ?? "proxmox",
    store: process.env.OMP_SECRETS_STORE ?? "/root/.secrets/omp-tokens.yaml",
    identity: process.env.OMP_SECRETS_IDENTITY ?? join(homedir(), ".config/omp-secrets/identity.txt"),
    cache: process.env.OMP_SECRETS_CACHE ?? join(homedir(), ".cache/omp-secrets/store.age"),
    offline: process.env.OMP_SECRETS_OFFLINE === "1",
  };
}

function validatePaths(cfg: StoreConfig): void {
  if (!isAbsolute(cfg.identity) || !isAbsolute(cfg.cache)) throw new Error("Identity and cache paths must be absolute");
  if (resolve(cfg.identity) === resolve(cfg.cache)) throw new Error("Identity and cache must be different files");
}

// Never include subprocess output in errors: decryption diagnostics may contain secrets.
export async function command(program: string, args: string[], input?: Buffer, timeout = 15_000): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  const fail = (message: string) => { if (!failed) { failed = true; child.kill("SIGKILL"); reject(new Error(message)); } };
  const timer = setTimeout(() => fail(`${program} timed out`), timeout);
  child.on("error", () => fail(`${program} could not start`));
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) fail(`${program} output exceeds 16 MiB`);
    else chunks.push(chunk);
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.on("close", code => {
    clearTimeout(timer);
    if (failed) return;
    if (code !== 0) reject(new Error(`${program} failed (exit ${code})`));
    else resolve(Buffer.concat(chunks));
  });
  child.stdin.end(input);
  return await promise;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("Secret directory must be owner-only (chmod 700) and owned by the current user");
  }
}

export async function initialize(cfg: StoreConfig): Promise<void> {
  validatePaths(cfg);
  await privateDirectory(dirname(cfg.identity));
  // Create exclusively; never rotate or overwrite an existing offline identity.
  const key = await command("age-keygen", []);
  let file;
  try { file = await open(cfg.identity, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error: unknown) {
    key.fill(0);
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") { await recipient(cfg); return; }
    throw new Error("Cannot create offline identity");
  }
  try { await file.writeFile(key); await file.sync(); } finally { await file.close(); key.fill(0); }
}

async function recipient(cfg: StoreConfig): Promise<string> {
  let file;
  try { file = await open(cfg.identity, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error("Offline identity is missing; run omp-secrets init"); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Offline identity must be an owner-only regular file (chmod 600)");
  } finally { await file.close(); }
  const result = (await command("age-keygen", ["-y", cfg.identity])).toString().trim();
  if (!/^age1[0-9a-z]+$/.test(result)) throw new Error("Offline identity must contain one age X25519 identity");
  return result;
}

function parse(data: Buffer): { values: Record<string, string>; entries: Entry[] } {
  let root: unknown;
  try { root = JSON.parse(data.toString("utf8")); } catch { throw new Error("Decrypted store is not valid JSON"); }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Secret store must be an object");
  const values: Record<string, string> = Object.create(null);
  const entries: Entry[] = [];
  function visit(node: Record<string, unknown>, prefix: string[]) {
    for (const [key, value] of Object.entries(node)) {
      if (prefix.length === 0 && key === "EXAMPLE_TOKEN") continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) throw new Error("Secret keys must contain only letters, digits, underscores, and hyphens");
      const path = [...prefix, key];
      if (value && typeof value === "object" && !Array.isArray(value)) { visit(value as Record<string, unknown>, path); continue; }
      if (typeof value !== "string" || value.length < 8 || value.includes("\0")) throw new Error("Every secret must be a NUL-free string of at least 8 characters for OMP environment redaction");
      const env = `OMP_SECRET_${path.join("_").replaceAll("-", "_").toUpperCase()}`;
      if (Object.hasOwn(values, env)) throw new Error("Secret paths collide after environment-name normalization");
      values[env] = value;
      entries.push({ path: path.join("/"), env });
    }
  }
  visit(root as Record<string, unknown>, []);
  if (!entries.length) throw new Error("Secret store contains no usable secrets");
  return { values, entries };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fetchSnapshot(cfg: StoreConfig, publicKey: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(cfg.host) || !cfg.store.startsWith("/") || /[\r\n\0]/.test(cfg.store)) throw new Error("Invalid SSH host or absolute store path");
  // Remote plaintext flows only through a pipe. The workstation receives only age ciphertext.
  const script = `set -euo pipefail; export SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt; sops --decrypt --output-type json ${quote(cfg.store)} | age --encrypt --recipient ${quote(publicKey)}`;
  return await command("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1", cfg.host, `bash -c ${quote(script)}`]);
}

async function decrypt(cfg: StoreConfig, snapshot: Buffer) {
  const plaintext = await command("age", ["--decrypt", "--identity", cfg.identity], snapshot);
  try { return parse(plaintext); } finally { plaintext.fill(0); }
}

async function save(cfg: StoreConfig, snapshot: Buffer): Promise<string> {
  await privateDirectory(dirname(cfg.cache));
  const temporary = `${cfg.cache}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(snapshot); await file.sync(); await file.close();
    await rename(temporary, cfg.cache);
    return (await stat(cfg.cache)).mtime.toISOString();
  } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
}

export async function load(cfg: StoreConfig, requireRemote = false): Promise<LoadedStore> {
  validatePaths(cfg);
  const publicKey = await recipient(cfg);
  if (!cfg.offline) {
    let snapshot: Buffer;
    try { snapshot = await fetchSnapshot(cfg, publicKey); }
    catch {
      if (requireRemote) throw new Error("Central store unavailable; encrypted cache was not changed");
      return await cached(cfg);
    }
    // Fetch failures permit offline use; received corruption/schema errors do not.
    const parsed = await decrypt(cfg, snapshot);
    const cachedAt = await save(cfg, snapshot);
    return { values: parsed.values, catalog: { source: "remote", cachedAt, entries: parsed.entries } };
  }
  if (requireRemote) throw new Error("Cannot sync in offline mode");
  return await cached(cfg);
}

async function cached(cfg: StoreConfig): Promise<LoadedStore> {
  let snapshot: Buffer;
  try { snapshot = await readFile(cfg.cache); } catch { throw new Error("Central store unavailable and no encrypted offline cache exists; run omp-secrets sync while online"); }
  const parsed = await decrypt(cfg, snapshot);
  return { values: parsed.values, catalog: { source: "cache", cachedAt: (await stat(cfg.cache)).mtime.toISOString(), entries: parsed.entries } };
}
