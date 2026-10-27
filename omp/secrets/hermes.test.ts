import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { command, initialize, type StoreConfig } from "./store";

let directory: string;
let cfg: StoreConfig;
let publicKey: string;
let env: Record<string, string>;
const cli = resolve(import.meta.dir, "../../bin/omp-secrets");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omp-hermes-test-"));
  cfg = { host: "unused", store: "/unused", identity: join(directory, "keys/identity.txt"), cache: join(directory, "cache/store.age"), offline: true, cacheTtlSeconds: 300 };
  await initialize(cfg);
  publicKey = (await command("age-keygen", ["-y", cfg.identity])).toString().trim();
  await mkdir(dirname(cfg.cache), { mode: 0o700 });
  // Deliberately do not inherit startup-injected credentials or live store settings.
  const binaries = join(directory, "bin");
  await mkdir(binaries);
  // Every potential SSH call is intercepted, even if a test accidentally goes online.
  await writeFile(join(binaries, "ssh"), "#!/bin/sh\nprintf 'fetch\\n' >> \"$TEST_SSH_CALLS\"\nif [ \"$TEST_SSH_FAIL\" = 1 ]; then exit 1; fi\nexec /bin/cat \"$TEST_REMOTE_SNAPSHOT\"\n", { mode: 0o700 });
  env = { PATH: `${binaries}:${process.env.PATH!}`, HOME: directory, OMP_SECRETS_HOST: "synthetic-host", OMP_SECRETS_STORE: "/synthetic-store", OMP_SECRETS_OFFLINE: "1", OMP_SECRETS_IDENTITY: cfg.identity, OMP_SECRETS_CACHE: cfg.cache, HERMES_SECRET_KEY: "", TEST_SSH_CALLS: join(directory, "ssh-calls"), TEST_SSH_FAIL: "1", TEST_REMOTE_SNAPSHOT: join(directory, "remote.age") };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function snapshot(value: unknown) {
  await writeFile(cfg.cache, await command("age", ["--recipient", publicKey], Buffer.from(JSON.stringify(value))), { mode: 0o600 });
}
async function remoteSnapshot(value: unknown) {
  await writeFile(env.TEST_REMOTE_SNAPSHOT!, await command("age", ["--recipient", publicKey], Buffer.from(JSON.stringify(value))), { mode: 0o600 });
  env.TEST_SSH_FAIL = "0";
  env.OMP_SECRETS_OFFLINE = "0";
}
async function fetchCalls() {
  try { return (await readFile(env.TEST_SSH_CALLS!, "utf8")).trim().split("\n"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
function tokenResult(result: CLIResult, value: string) {
  expect(result).toEqual({ code: 0, stderr: "", stdout: `OMP_SECRET_TOKEN='${value}'\n` });
}
function decodeMarkers(value: string): string {
  const markers: Record<string, string> = { "\\": "\\", r: "\r", n: "\n" };
  return value.replace(/\\([\s\S])|\\$/g, (_match, marker: string | undefined) => {
    if (marker === undefined || !Object.hasOwn(markers, marker)) throw new Error("Invalid newline marker");
    return markers[marker]!;
  });
}
interface CLIResult { stdout: string; stderr: string; code: number }
async function invoke(args = ["hermes"], executable = cli): Promise<CLIResult> {
  const child = Bun.spawn([process.execPath, executable, ...args], { env, cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
function failed(result: CLIResult) {
  expect(result).toEqual({ stdout: "", stderr: "omp-secrets: Hermes bulk export failed\n", code: 1 });
}

test("bulk export preserves literal quotes, whitespace, equals, shell syntax and Unicode through a symlink", async () => {
  await snapshot({ nested: { "api-key": "  synthetic'\"$`\\=☃#fixture  " }, TOKEN: "'synthetic-quoted'" });
  const link = join(directory, "adapter");
  await symlink(cli, link);
  const before = await readFile(cfg.cache);
  expect(await invoke(["hermes"], link)).toEqual({ code: 0, stderr: "", stdout: "OMP_SECRET_NESTED_API_KEY='  synthetic'\"$`\\=☃#fixture  '\nOMP_SECRET_TOKEN=''synthetic-quoted''\n" });
  expect(await readFile(cfg.cache)).toEqual(before);
});

test("multiline, carriage returns and whitespace-only values fail atomically", async () => {
  for (const value of ["synthetic\nINJECTED=fixture", "synthetic\rfixture", "         "]) {
    await snapshot({ VALID: "synthetic-valid", INVALID: value });
    failed(await invoke());
  }
});

test("output cap fails before writing any credentials", async () => {
  await snapshot({ VALID: "synthetic-valid", LARGE: "x".repeat(1024 * 1024) });
  failed(await invoke());
});

test("unsupported operations do not attempt store access", async () => {
  failed(await invoke(["hermes", "get", "synthetic"]));
  env.HERMES_SECRET_KEY = "synthetic-requested-key";
  failed(await invoke());
});

test("missing, corrupt and schema-invalid stores emit no credentials or sensitive diagnostics", async () => {
  failed(await invoke());
  await writeFile(cfg.cache, "synthetic-corrupt-ciphertext");
  failed(await invoke());
  await snapshot({ "bad/key": "synthetic-sensitive-fixture" });
  failed(await invoke());
});

test("existing status remains metadata-only", async () => {
  await snapshot({ TOKEN: "synthetic-fixture" });
  const result = await invoke(["status"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).entries).toEqual([{ path: "TOKEN", env: "OMP_SECRET_TOKEN" }]);
  expect(result.stdout).not.toContain("synthetic-fixture");
});

test("default TTL reuses a fresh cache without SSH or cache writes", async () => {
  await snapshot({ TOKEN: "synthetic-cached" });
  await remoteSnapshot({ TOKEN: "synthetic-remote" });
  const before = await stat(cfg.cache);
  tokenResult(await invoke(), "synthetic-cached");
  expect(await fetchCalls()).toEqual([]);
  expect((await stat(cfg.cache)).mtimeMs).toBe(before.mtimeMs);
});

test("expired cache refreshes once and the next invocation uses validated ciphertext", async () => {
  await snapshot({ TOKEN: "synthetic-cached" });
  await utimes(cfg.cache, 0, 0);
  await remoteSnapshot({ TOKEN: "synthetic-remote" });
  tokenResult(await invoke(), "synthetic-remote");
  expect(await readFile(cfg.cache)).toEqual(await readFile(env.TEST_REMOTE_SNAPSHOT!));
  expect((await stat(cfg.cache)).mtimeMs).toBeGreaterThan(0);
  tokenResult(await invoke(), "synthetic-remote");
  expect(await fetchCalls()).toEqual(["fetch"]);
});

test("missing cache refreshes and persists only ciphertext", async () => {
  await remoteSnapshot({ TOKEN: "synthetic-remote" });
  tokenResult(await invoke(), "synthetic-remote");
  expect(await readFile(cfg.cache)).toEqual(await readFile(env.TEST_REMOTE_SNAPSHOT!));
  expect((await stat(cfg.cache)).mode & 0o077).toBe(0);
  expect(await fetchCalls()).toEqual(["fetch"]);
});

test("offline overrides TTL and forced sync without any SSH", async () => {
  await snapshot({ TOKEN: "synthetic-cached" });
  await utimes(cfg.cache, 0, 0);
  env.OMP_SECRETS_CACHE_TTL_SECONDS = "0";
  tokenResult(await invoke(), "synthetic-cached");
  const sync = await invoke(["sync"]);
  expect(sync.code).toBe(1);
  expect(sync.stdout).toBe("");
  expect(sync.stderr).toContain("Cannot sync in offline mode");
  await rm(cfg.cache);
  failed(await invoke());
  expect(await fetchCalls()).toEqual([]);
});

test("forced sync fetches despite freshness and never falls back on failure", async () => {
  await snapshot({ TOKEN: "synthetic-cached" });
  await remoteSnapshot({ TOKEN: "synthetic-remote" });
  const result = await invoke(["sync"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).source).toBe("remote");
  const before = await readFile(cfg.cache);
  env.TEST_SSH_FAIL = "1";
  const failure = await invoke(["sync"]);
  expect(failure.code).toBe(1);
  expect(failure.stdout).toBe("");
  expect(await readFile(cfg.cache)).toEqual(before);
  expect(await fetchCalls()).toEqual(["fetch", "fetch"]);
});

test("transport failure serves stale cache without extending TTL and retries next time", async () => {
  await snapshot({ TOKEN: "synthetic-cached" });
  await utimes(cfg.cache, 0, 0);
  env.OMP_SECRETS_OFFLINE = "0";
  const before = await readFile(cfg.cache);
  tokenResult(await invoke(), "synthetic-cached");
  tokenResult(await invoke(), "synthetic-cached");
  expect((await stat(cfg.cache)).mtimeMs).toBe(0);
  expect(await readFile(cfg.cache)).toEqual(before);
  await rm(cfg.cache);
  failed(await invoke());
  expect(await fetchCalls()).toEqual(["fetch", "fetch", "fetch"]);
});

test("zero TTL always fetches and future cache timestamps count as stale", async () => {
  await snapshot({ TOKEN: "synthetic-cached" });
  await remoteSnapshot({ TOKEN: "synthetic-remote" });
  env.OMP_SECRETS_CACHE_TTL_SECONDS = "0";
  tokenResult(await invoke(), "synthetic-remote");
  tokenResult(await invoke(), "synthetic-remote");
  env.OMP_SECRETS_CACHE_TTL_SECONDS = "300";
  const future = new Date(Date.now() + 3600_000);
  await utimes(cfg.cache, future, future);
  tokenResult(await invoke(), "synthetic-remote");
  expect(await fetchCalls()).toEqual(["fetch", "fetch", "fetch"]);
});

test("fresh corruption fails without SSH; received corruption never falls back or replaces cache", async () => {
  await writeFile(cfg.cache, "synthetic-corrupt-cache");
  await remoteSnapshot({ TOKEN: "synthetic-remote" });
  failed(await invoke());
  expect(await fetchCalls()).toEqual([]);
  await snapshot({ TOKEN: "synthetic-cached" });
  await utimes(cfg.cache, 0, 0);
  const before = await readFile(cfg.cache);
  await writeFile(env.TEST_REMOTE_SNAPSHOT!, "synthetic-corrupt-remote");
  failed(await invoke());
  expect(await readFile(cfg.cache)).toEqual(before);
  await remoteSnapshot({ TOKEN: "short" });
  failed(await invoke());
  expect(await readFile(cfg.cache)).toEqual(before);
  expect((await stat(cfg.cache)).mtimeMs).toBe(0);
  await writeFile(cfg.cache, "synthetic-corrupt-cache");
  await utimes(cfg.cache, 0, 0);
  env.TEST_SSH_FAIL = "1";
  failed(await invoke());
  expect(await fetchCalls()).toEqual(["fetch", "fetch", "fetch"]);
});

test("invalid TTL fails before cache or SSH access even offline", async () => {
  await snapshot({ TOKEN: "synthetic-cached" });
  for (const ttl of ["", "-1", "NaN", "Infinity", "1e3", " 3", "3 ", "0x10", "1foo", "9007199254740992"]) {
    env.OMP_SECRETS_CACHE_TTL_SECONDS = ttl;
    failed(await invoke());
  }
  expect(await fetchCalls()).toEqual([]);
  env.OMP_SECRETS_CACHE_TTL_SECONDS = "0.5";
  tokenResult(await invoke(), "synthetic-cached");
});

test("explicit markers distinguish LF, CR, CRLF, literal backslash-n and trailing slashes", async () => {
  const cases = [
    ["synthetic\nline", "synthetic\\nline"],
    ["synthetic\rline", "synthetic\\rline"],
    ["synthetic\r\nline", "synthetic\\r\\nline"],
    ["synthetic\\nline", "synthetic\\\\nline"],
    ["synthetic\\r\\n\\\\tail\\", "synthetic\\\\r\\\\n\\\\\\\\tail\\\\"],
    ["  synthetic'\"$`☃=\\\r\nend  ", "  synthetic'\"$`☃=\\\\\\r\\nend  "],
  ];
  for (const [original, encoded] of cases) {
    await snapshot({ TOKEN: original! });
    tokenResult(await invoke(["hermes", "--escape-newlines"]), encoded!);
    expect(decodeMarkers(encoded!)).toBe(original!);
    if (/[\r\n]/.test(original!)) failed(await invoke());
    else tokenResult(await invoke(), original!);
  }
  await snapshot({ TOKEN: "         " });
  failed(await invoke(["hermes", "--escape-newlines"]));
});

test("escaped output cap includes marker expansion", async () => {
  await snapshot({ TOKEN: "\\".repeat(600_000) });
  failed(await invoke(["hermes", "--escape-newlines"]));
});

const hermesSource = process.env.HERMES_TEST_SOURCE;
const hermesPython = process.env.HERMES_TEST_PYTHON;
test.skipIf(!hermesSource || !hermesPython)("installed Hermes CommandSource consumes the real CLI using isolated synthetic ciphertext", async () => {
  const value = "  synthetic'\"$`\\=☃#fixture  ";
  await snapshot({ nested: { token: value } });
  const multiline = "  synthetic'\"$`☃\\n\\r\\\\tail\\\r\nCR\rLF\nend  ";
  await remoteSnapshot({ nested: { token: value }, MULTILINE: multiline });
  const script = String.raw`
import os, shlex, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from agent.secret_sources.base import set_source_environment, reset_source_environment
from agent.secret_sources.command import CommandSource

def decode_omp_markers(value):
    result = []
    i = 0
    markers = {"\\": "\\", "r": "\r", "n": "\n"}
    while i < len(value):
        if value[i] != "\\":
            result.append(value[i])
            i += 1
            continue
        i += 1
        if i == len(value) or value[i] not in markers:
            raise ValueError("Invalid OMP newline marker")
        result.append(markers[value[i]])
        i += 1
    return "".join(result)

# Explicit view avoids Hermes environment/config loading and any live credentials.
environ = dict(os.environ)
token = set_source_environment(environ)
try:
    source = CommandSource()
    cfg = {"command": shlex.join([sys.argv[2], "hermes"]), "helper_timeout_seconds": 3}
    home = Path(environ["HOME"])
    calls = Path(environ["TEST_SSH_CALLS"])
    cache = Path(environ["OMP_SECRETS_CACHE"])
    result = source.fetch(cfg, home)
    assert result.secrets == {"OMP_SECRET_NESTED_TOKEN": sys.argv[3]}, "synthetic default roundtrip failed"
    assert not calls.exists(), "fresh TTL must skip SSH"
    os.utime(cache, (0, 0))
    result = source.fetch(cfg, home)
    assert not result.secrets and result.error, "default multiline export must fail"
    assert cache.read_bytes() == Path(environ["TEST_REMOTE_SNAPSHOT"]).read_bytes(), "TTL refresh must persist ciphertext"
    assert calls.read_text() == "fetch\n", "expired TTL must refresh once"
    cfg["command"] += " --escape-newlines"
    for _ in range(2):
        result = source.fetch(cfg, home)
        assert not result.error, "escaped export failed"
        decoded = {name: decode_omp_markers(value) for name, value in result.secrets.items()}
        assert decoded == {"OMP_SECRET_NESTED_TOKEN": sys.argv[3], "OMP_SECRET_MULTILINE": sys.argv[4]}, "marker roundtrip failed"
        assert result.secrets["OMP_SECRET_MULTILINE"] != sys.argv[4], "Hermes must retain encoded markers"
    assert calls.read_text() == "fetch\n", "subsequent source fetch must use fresh cache"
    cache.unlink()
    environ["TEST_SSH_FAIL"] = "1"
    result = source.fetch(cfg, home)
    assert not result.secrets and result.error, "failed helper must resolve no credentials"
    assert calls.read_text() == "fetch\nfetch\n", "missing TTL cache must attempt refresh"
    print("Installed Hermes TTL, default rejection, marker roundtrip and failure contract passed")
finally:
    reset_source_environment(token)
`;
  const child = Bun.spawn([hermesPython!, "-c", script, hermesSource!, cli, value, multiline], { env, cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(stdout).toBe("Installed Hermes TTL, default rejection, marker roundtrip and failure contract passed\n");
  expect(stderr).toContain("code=1 signal=none");
  expect(stderr).not.toContain(value);
  expect(stderr).not.toContain(multiline);
});
