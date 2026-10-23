import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { OMP_BRIDGE_ARGS_ENV, OMP_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { OmpRpcSession } from "./rpc-session.js";

const fakeOmpPath = fileURLToPath(new URL("./fake-omp-rpc.mjs", import.meta.url));

async function withStartupUi(
  request: Record<string, unknown>,
  test: (session: OmpRpcSession, log: string, rpcLog: string) => Promise<void>,
  onExtensionUiRequest?: (request: Record<string, unknown>) => void,
  onExtensionUiReset?: () => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bb-omp-helper-ui-"));
  const log = join(dir, "responses.jsonl");
  const rpcLog = join(dir, "rpc.jsonl");
  vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, process.execPath);
  vi.stubEnv(OMP_BRIDGE_ARGS_ENV, JSON.stringify([fakeOmpPath]));
  vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify(request));
  vi.stubEnv("FAKE_OMP_UI_LOG", log);
  vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
  const session = new OmpRpcSession(
    {
      cwd: dir,
      sessionDir: join(dir, "sessions"),
      scratchDir: join(dir, "scratch"),
      recordThreadId: "thr_helper_ui",
      onExtensionUiRequest,
      onExtensionUiReset,
    },
    async () => ({ content: "", isError: true }),
    () => undefined,
    () => undefined,
  );
  try {
    await session.start();
    await test(session, log, rpcLog);
  } finally {
    try {
      await session.closeGracefully(1000);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }
}

it.each([
  { method: "select", title: "Pick", options: ["A", "B"] },
  { method: "confirm", title: "Startup confirmation", message: "Continue?" },
  { method: "input", title: "Startup input", placeholder: "Value" },
  { method: "editor", title: "Startup editor", prefill: "Draft", promptStyle: true },
  { method: "ask", questions: [{ id: "choice", question: "Choose", options: [{ label: "A" }, { label: "B" }], multi: true }] },
])("auto-cancels native $method dialogs in helper sessions without a UI handler", async (request) => {
  await withStartupUi({ id: "ui-helper", ...request }, async (_session, log, rpcLog) => {
    expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual({
      type: "extension_ui_response",
      id: "ui-helper",
      cancelled: true,
    });
    const commands: unknown[] = readFileSync(rpcLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(commands).toContainEqual(expect.objectContaining({ type: "set_ask_dialog", enabled: true }));
  });
});

it.each(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url", "cancel"])("does not answer native fire-and-forget %s in helper sessions", async (method) => {
  await withStartupUi({ id: "ui-notice", method, message: "Notice", title: "Notice", url: "https://example.com", targetId: "missing" }, async (session, log) => {
    await session.getState();
    expect(existsSync(log)).toBe(false);
  });
});

it("forwards native notifications to a configured coordinator without manufacturing a response", async () => {
  const onExtensionUiRequest = vi.fn();
  await withStartupUi({ id: "ui-cancel", method: "cancel", targetId: "pending-ui" }, async (session, log) => {
    await session.getState();
    expect(onExtensionUiRequest).toHaveBeenCalledExactlyOnceWith({
      type: "extension_ui_request",
      id: "ui-cancel",
      method: "cancel",
      targetId: "pending-ui",
    });
    expect(existsSync(log)).toBe(false);
  }, onExtensionUiRequest);
});

it("resets extension state before startup frames and when the current child exits", async () => {
  const sequence: string[] = [];
  await withStartupUi(
    { method: "setStatus", statusKey: "worker", statusText: "Ready" },
    async (session, log) => {
      expect(sequence).toEqual(["reset", "request"]);
      expect(existsSync(log)).toBe(false);
      await session.closeGracefully(1000);
      await vi.waitFor(() => expect(sequence).toEqual(["reset", "request", "reset"]));
    },
    () => { sequence.push("request"); },
    () => { sequence.push("reset"); },
  );
});
