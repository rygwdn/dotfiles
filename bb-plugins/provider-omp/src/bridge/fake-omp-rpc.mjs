#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);
const processLogPath = process.env.FAKE_OMP_PROCESS_LOG;

function logProcessStep(step) {
  if (processLogPath) {
    appendFileSync(processLogPath, `${step}:${process.pid}:${process.ppid}\n`);
  }
}

if (args.includes("--version") || args.includes("-v")) {
  logProcessStep("version");
  if (process.env.FAKE_OMP_VERSION_STDERR) {
    process.stderr.write(`${process.env.FAKE_OMP_VERSION_STDERR}\n`);
  }
  if (process.env.FAKE_OMP_VERSION === "crash") {
    process.stderr.write("Error: omp failed to start\n");
    process.exit(1);
  }
  process.stdout.write(`omp/${process.env.FAKE_OMP_VERSION ?? "18.10.4"}\n`);
  process.exit(0);
}

function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// Real omp exits on unknown flags; mirror that so wrong argv fails tests, not live threads.
const VALUE_FLAGS = new Set([
  "--mode", "--cwd", "--session-dir", "--session", "--resume", "--fork", "--model",
  "--thinking", "--system-prompt", "--append-system-prompt", "--config",
]);
const BOOLEAN_FLAGS = new Set(["--continue", "--no-session"]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (VALUE_FLAGS.has(arg)) index += 1;
  else if (!BOOLEAN_FLAGS.has(arg)) {
    process.stderr.write(`Error: unknown flag: ${arg}\n`);
    process.exit(1);
  }
}
if (process.env.FAKE_OMP_LAUNCH_LOG) {
  appendFileSync(process.env.FAKE_OMP_LAUNCH_LOG, `${JSON.stringify({
    args,
    cwd: process.cwd(),
    threadId: process.env.BB_THREAD_ID ?? null,
    marker: process.env.FAKE_OMP_ENV_MARKER ?? null,
  })}\n`);
}
if (process.env.FAKE_OMP_CONFIG_LOG) {
  for (let index = args.indexOf("--config"); index !== -1; index = args.indexOf("--config", index + 1)) {
    appendFileSync(process.env.FAKE_OMP_CONFIG_LOG, `${readFileSync(args[index + 1], "utf8")}\n`);
  }
}

logProcessStep("rpc");
logProcessStep("spawn");
if (process.env.FAKE_OMP_ENV_LOG) {
  appendFileSync(
    process.env.FAKE_OMP_ENV_LOG,
    `${process.env.FAKE_OMP_ENV_MARKER ?? ""}\n`,
  );
}

let exiting = false;
const hangOnClose = process.env.FAKE_OMP_HANG_ON_CLOSE === "1";
function exit(code = 0) {
  if (exiting) return;
  exiting = true;
  logProcessStep("exit");
  process.exit(code);
}
process.on("SIGTERM", () => {
  if (!hangOnClose) exit();
});

const MODELS = [
  {
    id: "fake-model",
    name: "Fake Model",
    provider: "fake-provider",
    input: ["text"],
    reasoning: true,
    thinking: {
      mode: "effort",
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    },
    contextWindow: 200_000,
  },
  {
    id: "fake-mini",
    name: "Fake Mini",
    provider: "fake-provider",
    input: ["text"],
    reasoning: false,
    thinking: null,
    contextWindow: 32_000,
  },
  ...[
    ["fake-gateway", "vendor/slash-model"],
    ["fake-gateway", "fake-provider/fake-model"],
    ["fake-gateway", "vendor/shared-model"],
    ["other-gateway", "vendor/shared-model"],
  ].map(([provider, id]) => ({
    id,
    name: id,
    provider,
    input: ["text"],
    reasoning: false,
    thinking: null,
    contextWindow: 64_000,
  })),
];

function loadAvailableModels() {
  if (!process.env.FAKE_OMP_MODELS_FILE) return MODELS;
  const parsed = JSON.parse(readFileSync(process.env.FAKE_OMP_MODELS_FILE, "utf8"));
  return Array.isArray(parsed) ? parsed : MODELS;
}

function findModel(provider, id) {
  return [...loadAvailableModels(), ...MODELS].find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.provider === provider &&
      entry.id === id,
  );
}

let spawnIndex = 1;
if (process.env.FAKE_OMP_SPAWN_COUNTER_FILE) {
  const path = process.env.FAKE_OMP_SPAWN_COUNTER_FILE;
  spawnIndex = existsSync(path) ? Number(readFileSync(path, "utf8")) + 1 : 1;
  writeFileSync(path, String(spawnIndex), "utf8");
}

const persisted = !args.includes("--no-session");
let sessionDir = resolve(
  flag("--session-dir") ??
    (flag("--session") ? dirname(flag("--session")) : ".fake-omp-sessions"),
);
let sessionFile;
let header;
let title = "";
let availableCommands = JSON.parse(process.env.FAKE_OMP_AVAILABLE_COMMANDS_JSON ?? "[]");
let entries = [];
let leafId = null;
let leafCounter = 0;
let turnCounter = 0;
let model = MODELS[0];
let thinkingLevel = "medium";
let fastModeEnabled = process.env.FAKE_OMP_FAST_MODE_ENABLED === "1";
let slowModeSupported = process.env.FAKE_OMP_SLOW_MODE_SUPPORTED === "1";
let slowModeScope = process.env.FAKE_OMP_SLOW_MODE_SCOPE ?? "session";
let configuredThinkingLevel;
let goalState = JSON.parse(process.env.FAKE_OMP_GOAL_STATE ?? "null");
const nativeSessionControls = {
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
  autoRetryEnabled: true,
  cacheWarmingMode: "off",
  slowModeEnabled: false,
  ...JSON.parse(process.env.FAKE_OMP_SESSION_CONTROLS ?? "{}"),
};
let tokens = 0;
let todoPhases = JSON.parse(process.env.FAKE_OMP_TODO_PHASES ?? "[]");

function readSession(path) {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const sessionHeader = records.find((entry) => entry.type === "session");
  if (!sessionHeader || typeof sessionHeader.id !== "string") {
    throw new Error(`Invalid session file: ${path}`);
  }
  return {
    header: sessionHeader,
    title: records.find((entry) => entry.type === "title")?.title ?? sessionHeader.title ?? "",
    entries: records.filter(
      (entry) =>
        entry.type !== "session" &&
        entry.type !== "title" &&
        typeof entry.id === "string",
    ),
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function newestNonemptySession(dir) {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || b.localeCompare(a))
    .find((path) => {
      try {
        const session = readSession(path);
        return (
          session.title.trim().length > 0 ||
          session.entries.some(
            (entry) =>
              entry.type === "message" &&
              (entry.message?.role === "assistant" ||
                entry.message?.role === "toolResult" ||
                entry.message?.role === "bashExecution" ||
                (entry.message?.role === "user" &&
                  messageText(entry.message.content).trim().length > 0)),
          )
        );
      } catch {
        return false;
      }
    });
}

function persistSession() {
  if (!sessionFile) return;
  mkdirSync(dirname(sessionFile), { recursive: true });
  const slot = {
    type: "title",
    v: 1,
    title,
    updatedAt: header.timestamp,
    pad: "",
  };
  const padding = Math.max(0, 255 - Buffer.byteLength(JSON.stringify(slot)));
  slot.pad = " ".repeat(padding);
  writeFileSync(
    sessionFile,
    [slot, header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}

function copyArtifacts(source, destination) {
  if (!source || !destination) return;
  const sourceRoot = realpathSync(source).replace(/\.jsonl$/u, "");
  if (sourceRoot === source || !existsSync(sourceRoot)) return;
  cpSync(sourceRoot, destination.replace(/\.jsonl$/u, ""), { recursive: true });
}

function createSession(history = [], parentSession, sourceFile) {
  const timestamp = new Date().toISOString();
  header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp,
    cwd: process.cwd(),
    ...(title ? { title } : {}),
    ...(parentSession ? { parentSession } : {}),
  };
  entries = structuredClone(history);
  leafId = entries.at(-1)?.id ?? null;
  sessionFile = persisted
    ? join(sessionDir, `${timestamp.replace(/[:.]/gu, "-")}_${header.id}.jsonl`)
    : undefined;
  persistSession();
  copyArtifacts(sourceFile, sessionFile);
}

function loadSession(path) {
  const session = readSession(path);
  header = session.header;
  title = session.title;
  entries = session.entries;
  leafId = entries.at(-1)?.id ?? null;
  sessionFile = persisted ? resolve(path) : undefined;
}

function branchEntries(id = leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  while (id !== null && id !== undefined) {
    const entry = byId.get(id);
    if (!entry || seen.has(id)) throw new Error(`Entry ${id} not found`);
    seen.add(id);
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function restoreSessionState() {
  const branch = branchEntries();
  for (const entry of branch) {
    if (entry.type === "model_change" && typeof entry.model === "string") {
      const slash = entry.model.indexOf("/");
      const restored = findModel(entry.model.slice(0, slash), entry.model.slice(slash + 1));
      if (restored) model = restored;
    }
    if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      thinkingLevel = entry.thinkingLevel;
    }
    if (entry.type === "custom" && entry.customType === "user_todo_edit") {
      todoPhases = entry.data.phases;
    }
    if (entry.type === "message" && entry.message?.role === "toolResult" &&
      entry.message.toolName === "todo" && !entry.message.isError &&
      Array.isArray(entry.message.details?.phases)) {
      todoPhases = entry.message.details.phases;
    }
  }
  turnCounter = entries.filter(
    (entry) => entry.type === "message" && entry.message.role === "user",
  ).length;
  leafCounter = entries.reduce((highest, entry) => {
    const match = /^leaf-(\d+)$/u.exec(entry.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  tokens = branch.reduce(
    (total, entry) => total + (entry.type === "message" ? entry.message.usage?.totalTokens ?? 0 : 0),
    0,
  );
}

try {
  if (flag("--fork")) {
    const source = resolve(flag("--fork"));
    const session = readSession(source);
    title = session.title;
    createSession(session.entries, session.header.id, source);
  } else if (flag("--session")) {
    loadSession(resolve(flag("--session")));
  } else {
    const current = args.includes("--continue") ? newestNonemptySession(sessionDir) : undefined;
    if (current) loadSession(current);
    else createSession();
  }
  restoreSessionState();
  if (process.env.FAKE_OMP_STATE_MODEL) {
    const stateModel = JSON.parse(process.env.FAKE_OMP_STATE_MODEL);
    model = { ...findModel(stateModel.provider, stateModel.id), ...stateModel };
  }
  const requestedModel = flag("--model");
  if (
    requestedModel &&
    !(process.env.FAKE_OMP_MISMATCH_FIRST_SPAWN === "1" && spawnIndex === 1)
  ) {
    const provider = flag("--provider");
    model = [...loadAvailableModels(), ...MODELS].find(
      (entry) =>
        entry &&
        (!provider || entry.provider === provider) &&
        (entry.id === requestedModel || `${entry.provider}/${entry.id}` === requestedModel),
    );
    if (!model) throw new Error(`Model not found: ${requestedModel}`);
  }
  configuredThinkingLevel = flag("--thinking");
  thinkingLevel = configuredThinkingLevel === "auto" ? "high" : configuredThinkingLevel ?? thinkingLevel;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}

function appendEntry(type, payload, id = randomUUID()) {
  const entry = {
    type,
    id,
    parentId: leafId,
    timestamp: new Date().toISOString(),
    ...payload,
  };
  entries.push(entry);
  leafId = id;
  persistSession();
  return entry;
}

function appendAssistant(message, final = true) {
  let id = randomUUID();
  if (final) {
    do {
      id = `leaf-${++leafCounter}`;
    } while (entries.some((entry) => entry.id === id));
  }
  return appendEntry("message", { message }, id);
}

function applyFinalLeaf() {
  const finalLeaf = process.env.FAKE_OMP_FINAL_LEAF;
  if (!finalLeaf || !leafId || entries.some((entry) => entry.id === finalLeaf)) return;
  const leaf = entries.find((entry) => entry.id === leafId);
  if (!leaf) return;
  leaf.id = finalLeaf;
  leafId = finalLeaf;
  persistSession();
}

const MAX_FRAME_BYTES = 1_048_576;
const MAX_REASSEMBLED_FRAME_BYTES = 67_108_864;
const RAW_CHUNK_BYTES = 262_144;
let protocolVersion = 1;
let chunkCounter = 0;
let heldLine = null;
let eventFilter = null;
let messageUpdates = "full";
let subagentSubscription = "off";

function encode(message) {
  const json = JSON.stringify(message);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length + 1 <= MAX_FRAME_BYTES) return `${json}\n`;
  if (protocolVersion !== 2 || bytes.length > MAX_REASSEMBLED_FRAME_BYTES) {
    return `${JSON.stringify(
      message.type === "response"
        ? {
            type: "response",
            id: message.id,
            command: message.command,
            success: false,
            error: "RPC frame exceeds the negotiated output limit",
            code: "frame_too_large",
          }
        : { type: "rpc_frame_error", error: "RPC event exceeds the negotiated output limit" },
    )}\n`;
  }
  const chunkId = `chunk-${++chunkCounter}`;
  const count = Math.ceil(bytes.length / RAW_CHUNK_BYTES);
  const frames = [];
  for (let index = 0; index < count; index++) {
    frames.push(JSON.stringify({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.length,
      data: bytes.subarray(index * RAW_CHUNK_BYTES, (index + 1) * RAW_CHUNK_BYTES).toString("base64"),
    }));
  }
  return frames.join("\n") + "\n";
}

function send(message) {
  const line = encode(message);
  process.stdout.write(heldLine === null ? line : heldLine + line);
  heldLine = null;
}

function respond(id, command, data) {
  send({ type: "response", id, command, success: true, ...(data === undefined ? {} : { data }) });
}

function respondError(id, command, error, code) {
  send({ type: "response", id, command, success: false, error, ...(code ? { code } : {}) });
}

const unfilteredFrames = new Set([
  "ready", "prompt_result", "session_settled", "extension_ui_request",
  "host_tool_call", "host_tool_cancel", "available_commands_update",
]);
function event(payload) {
  if (payload.type === "subagent_event" && subagentSubscription !== "events") return;
  if ((payload.type === "subagent_lifecycle" || payload.type === "subagent_progress") &&
    subagentSubscription === "off") return;
  if (eventFilter !== null && !unfilteredFrames.has(payload.type) && !eventFilter.includes(payload.type)) return;
  if (process.env.FAKE_OMP_EVENT_LOG) {
    appendFileSync(process.env.FAKE_OMP_EVENT_LOG, `${JSON.stringify(payload)}\n`);
  }
  send(payload);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const hostTools = new Map();
const hostToolWaiters = new Map();
const extensionUiWaiters = new Map();
const followUp = [];
const steering = [];
let activeRun = null;
let pumpTask = null;
let backgroundPending = false;
let isStreaming = false;
let isCompacting = false;
let messageCounter = 0;
let hostCallCounter = 0;

function queueUpdate() {
  event({
    type: "queue_update",
    steering: steering.map((item) => item.message),
    followUp: followUp.filter((item) => item.queued).map((item) => item.message),
    liveSteered: 0,
  });
}

function assistantMessage(text, stopReason = "stop", errorMessage) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: model.provider,
    model: model.id,
    api: "fake-api",
    usage: {
      input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 17,
      cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function emitAssistant(message, final = true) {
  const messageId = `message-${process.pid}-${++messageCounter}`;
  event({ type: "message_start", messageId, message: { role: "assistant", content: [] } });
  const text = messageText(message.content);
  if (text) {
    event({
      type: "message_update",
      messageId,
      message: messageUpdates === "delta" ? { role: "assistant" } : message,
      assistantMessageEvent: { type: "text_delta", delta: text, contentIndex: 0 },
    });
  }
  appendAssistant(message, final);
  event({ type: "message_end", messageId, message });
  event({ type: "turn_end", message, toolResults: [] });
  tokens += message.usage?.totalTokens ?? 0;
}

function agentEnd(extra = {}) {
  const messageCount = entries.slice(activeRun?.startIndex ?? 0)
    .filter((entry) => entry.type === "message").length;
  event({ type: "agent_end", messageCount, ...extra });
}

function promptResult(command, outcome, sessionSettled) {
  if (command.type !== "prompt" && command.type !== "abort_and_prompt") return;
  event({
    type: "prompt_result",
    id: command.id,
    agentInvoked: true,
    status: outcome.status,
    sessionSettled,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}

function admitNativeLocalCommand(command) {
  const text = command.message.trim();
  let output;
  if (text.startsWith("/native-queue ")) {
    const queues = JSON.parse(text.slice("/native-queue ".length));
    for (const [queue, messages] of [[steering, queues.steering ?? []], [followUp, queues.followUp ?? []]]) {
      queue.splice(0, queue.length, ...messages.map((message) => ({
        type: "fixture",
        message: typeof message === "string" ? message : message.text,
        ...(typeof message === "object" && message.images ? { images: message.images } : {}),
        queued: true,
      })));
    }
    output = "Native queue populated.";
  } else if (text === "/help") {
    output = "\u001b[1;36mNative OMP help\u001b[0m\n/help /todo /handoff";
  } else if (text.startsWith("/todo append ")) {
    const task = text.slice("/todo append ".length).trim();
    if (todoPhases.length === 0) todoPhases = [{ name: "Work", tasks: [] }];
    todoPhases[0].tasks.push({ content: task, status: "pending" });
    appendEntry("custom", { customType: "user_todo_edit", data: { phases: todoPhases } });
    output = `\u001b[32mAdded todo:\u001b[0m ${task}`;
  } else if (text === "/new") {
    title = "";
    createSession();
    restoreSessionState();
    output = "Started a new session";
  } else if (text === "/fork") {
    createSession(entries, header.id, sessionFile);
    restoreSessionState();
    output = "Forked the session";
  } else if (text.startsWith("/resume ")) {
    loadSession(resolve(text.slice("/resume ".length)));
    restoreSessionState();
    output = "Resumed the session";
  } else if (text === "/handoff" || text === "/handoff delayed") {
    output = "\u001b[1mHandoff summary\u001b[0m\nContinue from the canonical session state.";
  } else if (text === "/local-command-error") {
    output = "Local command output before failure";
  } else {
    return false;
  }
  const complete = () => {
    tokens += 23;
    if (text === "/local-command-error" && process.env.FAKE_OMP_LOCAL_ERROR_PRELUDE === "1") {
      event({ type: "goal_updated", goal: null });
    }
    event({ type: "command_output", text: output });
    if (text === "/local-command-error") respondError(command.id, command.type, "local admission failed");
    else respond(command.id, command.type, { agentInvoked: false });
    if (text.startsWith("/native-queue ")) setTimeout(queueUpdate, 0);
  };
  if (text === "/handoff delayed") setTimeout(complete, 30);
  else complete();
  return true;
}

let btwCounter = 0;
let btwHistorySessionFile;
let btwRecords = [];
let runningBtw;
const bashRuns = new Set();
let loginCounter = 0;
const fakeLogoutAccounts = [
  { credentialId: 7, provider: "account-test", label: "Primary account", detail: "primary@example.test", type: "oauth", active: true },
  { credentialId: 11, provider: "account-test", label: "Backup account", detail: "backup@example.test", type: "api_key", active: false },
];
const fakeLoginProviders = [
  { id: "oauth-test", name: "Test OAuth", available: true },
  { id: "account-test", name: "Existing accounts", available: true },
  { id: "secret-test", name: "Secret-only provider", available: false },
  { id: "oauth-error", name: "Failing OAuth", available: true },
];

function loadBtwRecords() {
  if (btwHistorySessionFile === sessionFile && btwRecords.length > 0) return btwRecords;
  if (btwHistorySessionFile !== sessionFile || btwRecords.length === 0) {
    const file = sessionFile ? join(sessionFile.replace(/\.jsonl$/u, ""), "btw-fixture.json") : undefined;
    btwRecords = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))
      : JSON.parse(process.env.FAKE_OMP_BTW_HISTORY ?? "[]");
    for (const record of btwRecords) {
      const latest = record.followUps?.at(-1) ?? record;
      if (latest.status === "running") latest.status = "interrupted";
    }
    btwHistorySessionFile = sessionFile;
    btwCounter = Math.max(btwCounter, btwRecords.length);
  }
  return btwRecords;
}

function saveBtwRecord(record) {
  const index = btwRecords.findIndex((previous) => previous.id === record.id);
  if (index < 0) btwRecords.push(record);
  else btwRecords[index] = record;
  if (sessionFile) {
    const root = sessionFile.replace(/\.jsonl$/u, "");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "btw-fixture.json"), JSON.stringify(btwRecords), "utf8");
  }
}

function finishBtw(running, patch) {
  if (runningBtw !== running) return;
  Object.assign(running.record.followUps?.at(-1) ?? running.record, patch, { updatedAt: Date.now() });
  runningBtw = undefined;
  saveBtwRecord(running.record);
  event({ type: "btw_record", record: running.record });
  if (process.env.FAKE_OMP_DUPLICATE_BTW_RECORD === "1") event({ type: "btw_record", record: running.record });
}

async function runBtw(command) {
  if (runningBtw) { respondError(command.id, command.type, "A /btw question is still running; cancel it first"); return; }
  const records = loadBtwRecords();
  const previous = command.recordId === undefined ? undefined : records.find((record) => record.id === command.recordId);
  if (command.recordId !== undefined && !previous) {
    respondError(command.id, command.type, `Unknown /btw topic: ${command.recordId}`);
    return;
  }
  const now = Date.now();
  const turn = { question: command.question, answer: "", status: "running", createdAt: now, updatedAt: now };
  const record = previous
    ? { ...previous, followUps: [...previous.followUps ?? [], turn] }
    : { id: `btw-${++btwCounter}`, leafId, ...turn };
  const running = { record };
  runningBtw = running;
  saveBtwRecord(record);
  event({ type: "btw_record", record });
  if (process.env.FAKE_OMP_BTW_CANCEL_DURING_START === "1") {
    finishBtw(running, { status: "cancelled" });
    respondError(command.id, command.type, "Side question cancelled while starting");
    return;
  }
  respond(command.id, command.type, { record });
  for (const delta of JSON.parse(process.env.FAKE_OMP_BTW_DELTAS ?? '["Partial BTW answer that must not leak."]')) {
    const latest = record.followUps?.at(-1) ?? record;
    latest.answer += delta;
    event({ type: "btw_delta", recordId: record.id, delta });
  }
  const releaseFile = process.env.FAKE_OMP_BTW_RELEASE_FILE;
  if (releaseFile) {
    while (runningBtw === running && !existsSync(releaseFile)) await sleep(10);
  } else {
    await sleep(20);
  }
  const status = command.question.includes("[error]") ? "error"
    : command.question.includes("[cancelled]") ? "cancelled"
      : command.question.includes("[interrupted]") ? "interrupted" : "complete";
  finishBtw(running, {
    status,
    answer: process.env.FAKE_OMP_BTW_ANSWER ?? `Side answer: ${command.question}`,
    ...(status === "error" ? { error: "scripted BTW failure" } : {}),
  });
}

async function runBash(command) {
  if (command.command === "[rpc-error]") {
    respondError(command.id, command.type, "scripted user shell RPC failure");
    return;
  }
  const run = { cancelled: false };
  bashRuns.add(run);
  const releaseFile = process.env.FAKE_OMP_BASH_RELEASE_FILE;
  if (releaseFile) {
    while (!run.cancelled && !existsSync(releaseFile)) await sleep(10);
  } else {
    await sleep(20);
  }
  bashRuns.delete(run);
  const output = `Executed by OMP: ${command.command}`;
  const result = {
    output,
    exitCode: run.cancelled ? 130 : 0,
    cancelled: run.cancelled,
    truncated: false,
    totalLines: 1, totalBytes: Buffer.byteLength(output),
    outputLines: 1, outputBytes: Buffer.byteLength(output),
    workingDir: process.cwd(),
    ...JSON.parse(process.env.FAKE_OMP_BASH_RESULT ?? "{}"),
  };
  appendEntry("message", { message: { role: "bashExecution", command: command.command, ...result, timestamp: Date.now() } });
  respond(command.id, command.type, result);
}

function openDialog(spec, run) {
  const id = spec.id ?? `ui-${turnCounter}`;
  const interactive = ["select", "confirm", "input", "editor", "ask"].includes(spec.method);
  const request = { ...spec, type: "extension_ui_request", id };
  if (spec.method === "cancel") {
    extensionUiWaiters.get(spec.targetId)?.resolve({ id: spec.targetId, cancelled: true });
    extensionUiWaiters.delete(spec.targetId);
  }
  if (!interactive) {
    event(request);
    return Promise.resolve(null);
  }
  return new Promise((resolveDialog) => {
    extensionUiWaiters.set(id, { resolve: resolveDialog, run });
    event(request);
  });
}

async function runTool(name, toolArgs, run, scriptedOutcome, assistantText) {
  const toolCallId = `call-${turnCounter}-${++hostCallCounter}`;
  const callMessage = {
    ...assistantMessage(assistantText ?? "", "toolUse"),
    content: [
      ...(assistantText ? [{ type: "text", text: assistantText }] : []),
      { type: "toolCall", id: toolCallId, name, arguments: toolArgs },
    ],
    ...(assistantText ? {} : { usage: { input: 0, output: 0, totalTokens: 0 } }),
  };
  const callMessageId = `message-${process.pid}-${++messageCounter}`;
  event({ type: "message_start", messageId: callMessageId, message: { role: "assistant", content: [] } });
  if (assistantText) event({
    type: "message_update", messageId: callMessageId, message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: assistantText },
  });
  appendAssistant(callMessage, false);
  event({ type: "message_end", messageId: callMessageId, message: callMessage });
  event({ type: "tool_execution_start", toolCallId, toolName: name, args: toolArgs });
  let outcome;
  if (scriptedOutcome !== undefined) {
    outcome = typeof scriptedOutcome === "function" ? await scriptedOutcome(toolCallId) : scriptedOutcome;
  } else if (hostTools.has(name)) {
    const id = `host-${hostCallCounter}`;
    outcome = await new Promise((resolveTool) => {
      hostToolWaiters.set(id, { resolve: resolveTool, run, toolCallId, toolName: name, args: toolArgs });
      event({ type: "host_tool_call", id, toolCallId, toolName: name, arguments: toolArgs });
    });
  } else {
    const builtin = ["bash", "read", "write", "edit"].includes(name);
    outcome = {
      result: { content: [{ type: "text", text: builtin ? `Built-in ${name} complete` : `Unknown tool: ${name}` }], details: {} },
      isError: !builtin,
    };
  }
  const { result, isError } = outcome;
  const message = {
    role: "toolResult", toolCallId, toolName: name,
    content: result.content, details: result.details, isError, timestamp: Date.now(),
  };
  event({ type: "tool_execution_end", toolCallId, toolName: name, result, isError });
  const messageId = `message-${process.pid}-${++messageCounter}`;
  event({ type: "message_start", messageId, message });
  appendEntry("message", { message });
  event({ type: "message_end", messageId, message });
  event({ type: "turn_end", message: callMessage, toolResults: [message] });
  event({ type: "turn_start" });
  return result;
}

// /subagents {"scenario":"batch"|"backfill"|"reset"|"detached"|"yielded"|"error",
//   "tasks"?:[{name,task,description,assignment}], "id"?:string, "holdParent"?:boolean,
//   "followUpOnCancel"?:boolean, "holdFollowUp"?:boolean} — yielded defaults to
// an autonomous root wake before an idle cancellation RPC response.
// Transcript reads are phase barriers, not timers: live frames follow the initial
// backfill, and a reset rewrites the file only after its old byte cursor was read.
const fakeSubagents = new Map();
const subagentTranscriptRefs = new Map();

function subagentProgress(agent, status = agent.snapshot.status) {
  return {
    id: agent.snapshot.id, index: agent.snapshot.index, agent: agent.snapshot.agent,
    task: agent.snapshot.task, description: agent.snapshot.description,
    ...(agent.snapshot.assignment ? { assignment: agent.snapshot.assignment } : {}),
    status, resolvedModel: "Fake Mini", resolvedModelIdentity: "fake-provider/fake-mini",
    currentTool: status === "running" ? "read" : undefined,
    currentToolIntent: status === "running" ? `Inspecting ${agent.snapshot.id}.txt` : undefined,
    lastIntent: `Inspecting ${agent.snapshot.id}.txt`, toolCount: agent.toolCount,
    tokens: agent.tokens, durationMs: agent.durationMs,
    recentOutput: agent.output ? [agent.output] : [],
    recentTools: agent.toolCount ? [{ tool: "read", intent: `Inspecting ${agent.snapshot.id}.txt` }] : [],
  };
}

function persistSubagent(agent) {
  mkdirSync(dirname(agent.snapshot.sessionFile), { recursive: true });
  writeFileSync(agent.snapshot.sessionFile, agent.records.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function appendSubagentMessage(agent, message) {
  agent.records.push({
    type: "message", id: randomUUID(),
    parentId: agent.records.findLast((entry) => entry.type !== "session")?.id ?? null,
    timestamp: new Date(message.timestamp).toISOString(), message,
  });
  persistSubagent(agent);
}

function createFakeSubagent(spec, index, parentToolCallId, detached) {
  const id = spec.name ?? spec.id ?? `worker-${String.fromCharCode(97 + index)}`;
  const timestamp = Date.now();
  const agent = {
    snapshot: {
      id, index, agent: spec.agent ?? "task", status: "running", lastUpdate: timestamp,
      task: spec.task ?? `Inspect ${id} fixtures`,
      description: spec.description ?? `Inspect ${id}`,
      ...(spec.assignment ? { assignment: spec.assignment } : {}),
      parentToolCallId, detached,
      sessionFile: join((sessionFile ?? join(sessionDir, header.id)).replace(/\.jsonl$/u, ""),
        "subagents", `${encodeURIComponent(id)}.jsonl`),
    },
    records: [{
      type: "session", version: 3, id: randomUUID(), timestamp: new Date(timestamp).toISOString(),
      cwd: process.cwd(), parentSession: header.id,
    }],
    readWaiters: [], tokens: 0, durationMs: 0, toolCount: 0, output: "",
    finalTokens: spec.tokens ?? 1_234 + index, finalDurationMs: spec.durationMs ?? 2_500 + index * 1_000,
    finalText: spec.finalText,
    timestamp, holdRun: undefined,
  };
  if (spec.padding) {
    agent.records.push({ type: "custom", id: randomUUID(), customType: "fixture_padding", data: " ".repeat(16_384) });
  }
  appendSubagentMessage(agent, { role: "user", content: agent.snapshot.task, timestamp });
  agent.snapshot.progress = subagentProgress(agent);
  fakeSubagents.set(id, agent);
  subagentTranscriptRefs.set(id, agent);
  while (subagentTranscriptRefs.size > 256) subagentTranscriptRefs.delete(subagentTranscriptRefs.keys().next().value);
  return agent;
}

function subagentEvent(agent, child) {
  event({ type: "subagent_event", payload: { id: agent.snapshot.id, event: child } });
}

function subagentLifecycle(agent, status) {
  const { id, index, description, parentToolCallId, sessionFile: childFile, detached } = agent.snapshot;
  event({ type: "subagent_lifecycle", payload: {
    id, index, agent: agent.snapshot.agent, status, description, parentToolCallId,
    sessionFile: childFile, detached,
  } });
}

function emitSubagentProgress(agent) {
  agent.snapshot.lastUpdate = Date.now();
  agent.snapshot.progress = subagentProgress(agent);
  event({ type: "subagent_progress", payload: {
    progress: agent.snapshot.progress, parentToolCallId: agent.snapshot.parentToolCallId,
    sessionFile: agent.snapshot.sessionFile, detached: agent.snapshot.detached,
  } });
}

function nextSubagentRead(agent) {
  return new Promise((resolveRead) => agent.readWaiters.push(resolveRead));
}

function childAssistant(agent, text, content, stopReason = "stop") {
  return {
    ...assistantMessage(text, stopReason), provider: "fake-provider", model: "fake-mini",
    timestamp: ++agent.timestamp,
    ...(content ? { content } : {}),
    usage: { input: 9_000, output: 876, cacheRead: 0, cacheWrite: 0, totalTokens: 9_876 },
  };
}

function recordChildAssistant(agent, message, live) {
  if (live) {
    subagentEvent(agent, { type: "message_start", message: { ...message, content: [] } });
    for (const [contentIndex, block] of message.content.entries()) {
      if (block.type === "thinking" || block.type === "text") {
        subagentEvent(agent, { type: "message_update", assistantMessageEvent: {
          type: block.type === "thinking" ? "thinking_delta" : "text_delta",
          delta: block.type === "thinking" ? block.thinking : block.text, contentIndex,
        } });
      }
    }
    subagentEvent(agent, { type: "message_end", message });
  }
  appendSubagentMessage(agent, message);
  const text = messageText(message.content);
  if (text) agent.output = text;
}

function fillSubagentTranscript(agent, live, terminal) {
  const id = agent.snapshot.id;
  const toolCallId = `${id}-read-1`;
  const args = { path: `${id}.txt` };
  if (live) subagentEvent(agent, { type: "agent_start" });
  const call = childAssistant(agent, "", [
    { type: "thinking", thinking: `${id} reasoning café` },
    { type: "text", text: `${id} live analysis café 🧪` },
    { type: "toolCall", id: toolCallId, name: "read", arguments: args },
  ], "toolUse");
  recordChildAssistant(agent, call, live);
  const result = { content: [{ type: "text", text: `${id} file contents café` }], details: {} };
  if (live) {
    subagentEvent(agent, { type: "tool_execution_start", toolCallId, toolName: "read", args });
    subagentEvent(agent, { type: "tool_execution_update", toolCallId, toolName: "read",
      partialResult: { content: [{ type: "text", text: `${id} reading progress` }] } });
    subagentEvent(agent, { type: "tool_execution_end", toolCallId, toolName: "read", result, isError: false });
  }
  const toolResult = {
    role: "toolResult", toolCallId, toolName: "read", ...result, isError: false, timestamp: ++agent.timestamp,
  };
  if (live) subagentEvent(agent, { type: "message_end", message: toolResult });
  appendSubagentMessage(agent, toolResult);
  agent.toolCount = 1;
  // Progress may lag the authoritative task result, including its final usage.
  agent.tokens = agent.finalTokens - 34;
  agent.durationMs = agent.finalDurationMs - 500;
  if (terminal) {
    const answer = childAssistant(agent, agent.finalText ?? `${id} final answer: café ✅`);
    recordChildAssistant(agent, answer, live);
    if (live) subagentEvent(agent, { type: "agent_end", messages: [call, toolResult, answer] });
  }
}

function finishFakeSubagent(agent, status) {
  agent.snapshot.status = status;
  agent.snapshot.lastUpdate = Date.now();
  agent.snapshot.progress = subagentProgress(agent);
  fakeSubagents.delete(agent.snapshot.id);
  subagentLifecycle(agent, status);
  agent.holdRun?.releaseHold?.("subagent-control");
}

function seedFakeSubagents() {
  const specs = JSON.parse(process.env.FAKE_OMP_SUBAGENTS ?? "[]");
  for (const [index, spec] of specs.entries()) {
    const agent = createFakeSubagent(spec, index, spec.parentToolCallId ?? "restored-task", spec.detached ?? true);
    fillSubagentTranscript(agent, false, false);
    agent.snapshot.progress = subagentProgress(agent);
  }
}

async function runSubagentScenario(spec, run) {
  const scenario = spec.scenario ?? "batch";
  const detached = scenario === "detached" || scenario === "yielded";
  const tasks = spec.tasks ?? (scenario === "batch" ? [
    { name: "worker-a", task: "Inspect request parsing", description: "Inspect parsing" },
    { name: "worker-b", assignment: "Review streaming order", description: "Review streaming" },
  ] : [{ name: spec.id ?? "worker-a" }]);
  if (scenario === "error") {
    await runTool("task", { tasks }, run, {
      result: { content: [{ type: "text", text: "No such agent: missing-worker" }], details: {} }, isError: true,
    });
    return;
  }
  const held = spec.holdParent ? new Promise((release) => { run.releaseHold = release; }) : undefined;
  await runTool("task", { tasks, ...(detached ? { async: true } : {}) }, run, async (parentToolCallId) => {
    const agents = tasks.map((task, index) => {
      const agent = createFakeSubagent({ ...task, padding: scenario === "reset" }, index, parentToolCallId, detached);
      agent.asyncWake = scenario === "yielded";
      agent.followUpOnCancel = agent.asyncWake && spec.followUpOnCancel !== false;
      agent.holdFollowUp = spec.holdFollowUp === true;
      if (held) agent.holdRun = run;
      return agent;
    });
    for (const agent of agents) {
      const read = nextSubagentRead(agent);
      subagentLifecycle(agent, "started");
      await read;
    }
    for (const agent of agents) {
      fillSubagentTranscript(agent, scenario !== "backfill", !detached);
      const read = nextSubagentRead(agent);
      emitSubagentProgress(agent);
      event({ type: "tool_execution_update", toolCallId: parentToolCallId, toolName: "task",
        partialResult: { content: [], details: { progress: agents.map((child) => subagentProgress(child)) } } });
      await read;
      if (scenario === "reset") {
        agent.records = agent.records.filter((entry) => entry.customType !== "fixture_padding");
        recordChildAssistant(agent, childAssistant(agent, `${agent.snapshot.id} after reset: naïve ✅`), false);
        const resetRead = nextSubagentRead(agent);
        emitSubagentProgress(agent);
        await resetRead;
      }
    }
    if (!detached) for (const agent of agents) finishFakeSubagent(agent, "completed");
    return {
      result: {
        content: [{ type: "text", text: detached ? "Background subagents started" : "Batch subagents complete" }],
        details: {
          progress: agents.map((agent) => subagentProgress(agent)),
          results: detached ? [] : agents.map((agent) => ({
            id: agent.snapshot.id, index: agent.snapshot.index, agent: agent.snapshot.agent,
            task: agent.snapshot.task, description: agent.snapshot.description,
            output: agent.output, exitCode: 0, tokens: agent.finalTokens, durationMs: agent.finalDurationMs,
            resolvedModel: "Fake Mini", resolvedModelIdentity: "fake-provider/fake-mini",
          })),
        },
      },
      isError: false,
    };
  });
  if (held) {
    await held;
    run.releaseHold = null;
  }
}

function readSubagentMessages(command) {
  const agent = command.subagentId === undefined
    ? [...subagentTranscriptRefs.values()].find((entry) => entry.snapshot.sessionFile === command.sessionFile)
    : subagentTranscriptRefs.get(command.subagentId);
  if (!agent) throw new Error("Unknown subagent or session file");
  const childFile = agent.snapshot.sessionFile;
  let fromByte = Math.max(0, Math.trunc(command.fromByte ?? 0));
  let nextByte = fromByte;
  let reset = false;
  let selected = [];
  if (existsSync(childFile)) {
    const bytes = readFileSync(childFile);
    reset = fromByte > bytes.length;
    if (reset) fromByte = 0;
    const remaining = bytes.subarray(fromByte);
    const complete = remaining.subarray(0, remaining.lastIndexOf(10) + 1);
    nextByte = fromByte + complete.length;
    selected = complete.toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  return { agent, data: {
    sessionFile: childFile, fromByte, nextByte, reset, entries: selected,
    messages: selected.filter((entry) => entry.type === "message").map((entry) => entry.message),
  } };
}

function cancelRun() {
  if (activeRun) {
    activeRun.aborted = true;
    activeRun.releaseHold?.("abort");
  }
  backgroundPending = false;
  for (const [id, pending] of hostToolWaiters) {
    hostToolWaiters.delete(id);
    event({ type: "host_tool_cancel", id: `cancel-${++hostCallCounter}`, targetId: id });
    pending.resolve({
      result: { content: [{ type: "text", text: `Host tool "${pending.toolName}" was aborted` }], details: {} },
      isError: true,
    });
  }
  for (const [id, pending] of extensionUiWaiters) {
    extensionUiWaiters.delete(id);
    event({ type: "extension_ui_request", id: `cancel-ui-${++messageCounter}`, method: "cancel", targetId: id });
    pending.resolve({ type: "extension_ui_response", id, cancelled: true });
  }
  for (const queued of followUp.splice(0)) promptResult(queued, { status: "aborted" }, false);
  for (const queued of steering.splice(0)) promptResult(queued, { status: "aborted" }, false);
  queueUpdate();
}

async function runPrompt(command) {
  const run = { command, aborted: false, joined: [], releaseHold: null, startIndex: entries.length };
  activeRun = run;
  isStreaming = true;
  turnCounter++;
  const branch = branchEntries();
  const selector = `${model.provider}/${model.id}`;
  if (branch.findLast((entry) => entry.type === "model_change")?.model !== selector) {
    appendEntry("model_change", { model: selector });
  }
  if (branch.findLast((entry) => entry.type === "thinking_level_change")?.thinkingLevel !== thinkingLevel) {
    appendEntry("thinking_level_change", { thinkingLevel });
  }
  appendEntry("message", {
    message: {
      role: "user",
      content: command.images?.length
        ? [{ type: "text", text: command.message }, ...command.images]
        : command.message,
      timestamp: Date.now(),
    },
  });
  event({ type: "agent_start" });
  event({ type: "turn_start" });
  command.onStarted?.();
  const text = command.message;
  let reply = `Response to: ${text}`;
  let reported = false;

  if (text === "/die") exit();
  if (text === "/hold" || text === "/wait-hold" || command.holdForSteer) {
    if (text === "/wait-hold") {
      event({ type: "tool_execution_start", toolCallId: "wait-1", toolName: "subagent_wait", args: {} });
    }
    const released = await new Promise((resolveHold) => { run.releaseHold = resolveHold; });
    run.releaseHold = null;
    if (text === "/wait-hold") {
      event({
        type: "tool_execution_end", toolCallId: "wait-1", toolName: "subagent_wait",
        result: { content: [{ type: "text", text: released === "steer" ? "Subagent finished" : "Wait interrupted" }] },
        isError: released !== "steer",
      });
    }
    const consumed = released === "steer" && process.env.FAKE_OMP_DROP_STEER_AT_END !== "1" ? steering.shift() : undefined;
    if (consumed) {
      run.joined.push(consumed);
      appendEntry("message", { message: { role: "user", content: consumed.message, timestamp: Date.now() } });
      queueUpdate();
    }
    if (released === "steer" && process.env.FAKE_OMP_DROP_STEER_AT_END === "1") {
      steering.length = 0;
    }
    reply = consumed ? `Steered: ${consumed.message}` : "Held run ended";
  }

  const uiMatch = /^\/ui (\{.*\}|\[.*\])$/su.exec(text);
  if (uiMatch && !run.aborted) {
    const spec = JSON.parse(uiMatch[1]);
    if (Array.isArray(spec)) {
      const responses = [];
      for (const request of spec) responses.push(await openDialog(request, run));
      reply = `UI said: ${JSON.stringify(responses)}`;
    } else {
      reply = `UI said: ${JSON.stringify(await openDialog(spec, run))}`;
    }
  }
  if (text === "/usage-loop" && !run.aborted) {
    for (let index = 1; index <= 2; index++) {
      await runTool("read", { path: `loop-${index}.txt` }, run, undefined, `Loop step ${index}`);
    }
    reply = "Loop complete";
  }
  const toolMatch = /^\/tool (\S+) ?(.*)$/su.exec(text);
  if (toolMatch && !run.aborted) {
    const toolArgs = toolMatch[2] ? JSON.parse(toolMatch[2]) : {};
    reply = `Tool said: ${messageText((await runTool(toolMatch[1], toolArgs, run)).content)}`;
  }
  const todosMatch = /^\/todos (\{.*\})$/su.exec(text);
  if (todosMatch && !run.aborted) {
    const spec = JSON.parse(todosMatch[1]);
    const via = spec.via ?? "todo";
    if (via === "reminder") {
      event({ type: "todo_reminder", todos: spec.phases.flatMap((phase) => phase.tasks), attempt: 1, maxAttempts: 3 });
    } else {
      if (!spec.isError) {
        todoPhases = spec.phases;
        appendEntry("custom", { customType: "user_todo_edit", data: { phases: todoPhases } });
      }
      if (via === "todo" || via === "eval") {
        const result = {
          content: [{ type: "text", text: "Todo fixture complete" }],
          details: via === "todo" ? { op: "init", phases: spec.phases, storage: "session" } : {},
        };
        await runTool(via, via === "todo"
          ? { op: "init", list: spec.phases.map((phase) => ({ phase: phase.name, items: phase.tasks.map((task) => task.content) })) }
          : { code: "await tool.todo({ op: 'view' })", language: "js" }, run, { result, isError: spec.isError === true });
      }
    }
  }
  const subagentsMatch = /^\/subagents (\{.*\})$/su.exec(text);
  if (subagentsMatch && !run.aborted) {
    await runSubagentScenario(JSON.parse(subagentsMatch[1]), run);
    reply = "Subagent fixture parent complete";
  }

  if (["/native-retry", "/native-overflow", "/failed-then-queued"].includes(text) && !run.aborted) {
    const unrecovered = text === "/failed-then-queued";
    const failureText = unrecovered ? "scripted unrecovered failure" : "scripted recoverable failure";
    const failed = assistantMessage("", "error", failureText);
    failed.usage = { input: 0, output: 0, totalTokens: 0 };
    emitAssistant(failed, false);
    isStreaming = false;
    agentEnd({ isTerminal: unrecovered, yielded: unrecovered });
    if (unrecovered) {
      promptResult(command, { status: "error", error: { message: failureText, retryable: false } }, false);
      reported = true;
      queueUpdate();
    } else if (text === "/native-retry") {
      event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: failureText });
      event({ type: "auto_retry_end", success: true, attempt: 1 });
    } else {
      event({ type: "auto_compaction_start", reason: "overflow", action: "context-full" });
      event({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: true });
    }
    isStreaming = true;
    run.startIndex = entries.length;
    event({ type: "agent_start" });
    event({ type: "turn_start" });
  }

  const aborted = run.aborted || text === "/unexpected-abort";
  const awaitingSubagents = !aborted && [...fakeSubagents.values()].some((agent) => agent.asyncWake);
  const overflowFailure = text === "/overflow-failed" || text === "/overflow-aborted";
  const failed = ["/fail-run", "/retry-exhausted"].includes(text);
  const stopReason = aborted ? "aborted" : failed ? "error" : overflowFailure ? "length" : "stop";
  const assistant = assistantMessage(aborted || failed ? "" : reply, stopReason, failed ? "scripted run failure" : undefined);
  if (aborted) assistant.usage = { input: 1, output: 0, totalTokens: 1 };
  emitAssistant(assistant);
  isStreaming = false;
  agentEnd({
    ...(text === "/background" ? { awaitingAsyncWork: true } : {}),
    ...(awaitingSubagents ? { yielded: true, awaitingAsyncWork: true, isTerminal: false } : {}),
  });
  if (text === "/retry-exhausted") {
    event({ type: "auto_retry_end", success: false, attempt: 3, finalError: "scripted run failure" });
  }
  const optionalOverflow = text === "/stop-overflow-cancel" || text === "/stop-overflow-error";
  const compactionError = text === "/overflow-failed" || text === "/stop-overflow-error";
  if (overflowFailure || optionalOverflow || text === "/threshold-cancel") {
    isCompacting = true;
    event({ type: "auto_compaction_start", reason: overflowFailure || optionalOverflow ? "overflow" : "threshold", action: "context-full" });
    event({ type: "auto_compaction_end", action: "context-full", willRetry: false, aborted: !compactionError, ...(compactionError ? { errorMessage: "overflow recovery exhausted" } : {}) });
    isCompacting = false;
  }
  if ((text === "/hold" || text === "/wait-hold") && !aborted) {
    isStreaming = process.env.FAKE_OMP_STREAMING_AFTER_END === "1";
  }
  return {
    status: aborted ? "aborted" : failed || overflowFailure ? "error" : "completed",
    ...(failed || overflowFailure ? { error: { message: overflowFailure ? "overflow recovery exhausted" : "scripted run failure", provider: model.provider, model: model.id, retryable: false } } : {}),
    background: text === "/background" && !aborted,
    yieldedAsync: awaitingSubagents,
    reported,
    joined: run.joined,
  };
}

async function pump() {
  while (followUp.length > 0) {
    const command = followUp.shift();
    if (command.queued) queueUpdate();
    const outcome = await runPrompt(command);
    activeRun = null;
    const settled = followUp.length === 0 && !outcome.background && !outcome.yieldedAsync;
    if (settled) applyFinalLeaf();
    if (!outcome.reported) promptResult(command, outcome, settled);
    for (const joined of outcome.joined) promptResult(joined, outcome, settled);
    if (outcome.background) {
      backgroundPending = true;
      await sleep(20);
      if (backgroundPending) {
        backgroundPending = false;
        followUp.unshift({ type: "background", message: "background work", queued: false });
      }
    }
  }
  activeRun = null;
  if ([...fakeSubagents.values()].some((agent) => agent.asyncWake)) return;
  applyFinalLeaf();
  event({ type: "session_settled" });
  if (process.env.FAKE_OMP_DUPLICATE_SETTLED === "1") event({ type: "session_settled" });
}

function startPump() {
  if (pumpTask) return;
  pumpTask = Promise.resolve().then(pump).catch((error) => {
    process.stderr.write(`Fake OMP run failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    exit(1);
  }).finally(() => {
    pumpTask = null;
    if (followUp.length > 0) startPump();
  });
}

function admitPrompt(command) {
  if (process.env.FAKE_OMP_PROMPT_DUMP) {
    writeFileSync(process.env.FAKE_OMP_PROMPT_DUMP, JSON.stringify(command), "utf8");
  }
  if (admitNativeLocalCommand(command)) return;
  if (/^\/rename(?:\s|$)/u.test(command.message)) {
    const name = command.message.slice("/rename".length).trim();
    if (name) {
      title = name;
      persistSession();
      event({ type: "session_info_update", title, sessionId: header.id });
    }
    respond(command.id, command.type, { agentInvoked: false });
    return;
  }
  if (command.message === "/session-info") {
    event({ type: "session_info_update", sessionId: header.id });
    respond(command.id, command.type, { agentInvoked: false });
    return;
  }
  if (command.message === "/refresh-commands") {
    availableCommands = JSON.parse(process.env.FAKE_OMP_UPDATED_COMMANDS_JSON ?? "[]");
    event({ type: "available_commands_update", commands: availableCommands });
    respond(command.id, command.type, { agentInvoked: false });
    return;
  }
  if (command.message.startsWith("/model ")) {
    const selector = command.message.slice("/model ".length).trim();
    const found = [...loadAvailableModels(), ...MODELS].find(
      (entry) => entry.id === selector || `${entry.provider}/${entry.id}` === selector,
    );
    if (!found) {
      respondError(command.id, command.type, `Model not found: ${selector}`);
      return;
    }
    model = found;
    appendEntry("model_change", { model: `${model.provider}/${model.id}` });
    event({ type: "model_changed" });
    event({ type: "config_update", model, thinkingLevel });
    respond(command.id, command.type, { agentInvoked: false });
    return;
  }
  if (command.message.startsWith("/effort ")) {
    const level = command.message.slice("/effort ".length).trim();
    configuredThinkingLevel = level;
    thinkingLevel = level === "auto" ? "high" : level;
    appendEntry("thinking_level_change", { thinkingLevel });
    event({
      type: "thinking_level_changed",
      thinkingLevel,
      ...(level === "auto" ? { configured: "auto", resolved: "high" } : {}),
    });
    event({ type: "config_update", model, thinkingLevel });
    respond(command.id, command.type, { agentInvoked: false });
    return;
  }
  if (/^\/fast(?:\s|$)/u.test(command.message)) {
    const value = command.message.slice("/fast".length).trim();
    fastModeEnabled = value === "" ? !fastModeEnabled : value === "on";
    event({ type: "config_update", model, thinkingLevel });
    respond(command.id, command.type, { agentInvoked: false });
    return;
  }
  if (["/slash-non-agent", "/noop"].includes(command.message)) {
    respond(command.id, command.type, { agentInvoked: false });
    return;
  }
  const busy = activeRun !== null || pumpTask !== null || followUp.length > 0;
  if (busy && command.streamingBehavior === "steer") {
    queueSteering(command);
    return;
  }
  followUp.push({ ...command, queued: busy });
  if (busy) queueUpdate();
  respond(command.id, command.type);
  startPump();
}

function queueSteering(command) {
  steering.push(command);
  queueUpdate();
  const response = { type: "response", id: command.id, command: command.type, success: true };
  if (process.env.FAKE_OMP_BATCH_STEER_REPLY === "1" && activeRun?.releaseHold) heldLine = encode(response);
  else send(response);
  activeRun?.releaseHold?.("steer");
}

function state() {
  return {
    model, thinkingLevel, isStreaming, isCompacting,
    fastModeEnabled,
    fastModeActive: fastModeEnabled && process.env.FAKE_OMP_FAST_MODE_INACTIVE !== "1",
    slowModeSupported,
    slowModeEnabled: slowModeSupported && nativeSessionControls.slowModeEnabled,
    ...(slowModeSupported ? { slowModeScope } : {}),
    steeringMode: nativeSessionControls.steeringMode,
    followUpMode: nativeSessionControls.followUpMode,
    interruptMode: nativeSessionControls.interruptMode,
    sessionFile, sessionId: header.id,
    autoCompactionEnabled: nativeSessionControls.autoCompactionEnabled,
    messageCount: branchEntries().filter((entry) => entry.type === "message").length,
    queuedMessageCount: followUp.length + steering.length,
    queuedMessages: {
      steering: steering.map((item) => item.message),
      followUp: followUp.filter((item) => item.queued).map((item) => item.message),
      liveSteered: 0,
    },
    contextUsage: { tokens, contextWindow: model.contextWindow, percent: 0 },
    todoPhases,
    goal: goalState,
  };
}

function forkLeaf(entryId) {
  const branch = branchEntries(entryId);
  const answered = new Set();
  let batch;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    if (entry.message.role === "toolResult") { answered.add(entry.message.toolCallId); continue; }
    if (entry.message.role === "assistant") batch = entry.message;
    break;
  }
  const pending = new Set((batch?.content ?? []).filter((block) => block.type === "toolCall" && !answered.has(block.id)).map((block) => block.id));
  let leaf = entryId;
  let cursor = entryId;
  while (pending.size > 0) {
    const children = entries.filter((entry) => entry.parentId === cursor);
    const result = children.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && pending.has(entry.message.toolCallId));
    if (result) { pending.delete(result.message.toolCallId); leaf = cursor = result.id; continue; }
    if (children.length !== 1 || children[0].type === "message") break;
    cursor = children[0].id;
  }
  return leaf;
}

async function handle(command) {
  const { id, type } = command;
  switch (type) {
    case "negotiate_protocol":
      if (command.protocolVersion !== 2) { respondError(id, type, "Unsupported protocol version"); return; }
      respond(id, type, { protocolVersion: 2 });
      protocolVersion = 2;
      return;
    case "get_state": {
      const snapshot = state();
      const gateDirectory = process.env.FAKE_OMP_LOCAL_STATE_GATES_DIR;
      if (!gateDirectory || snapshot.contextUsage.tokens === 0) {
        respond(id, type, snapshot);
        return;
      }
      const captured = structuredClone(snapshot);
      const token = captured.contextUsage.tokens;
      mkdirSync(gateDirectory, { recursive: true });
      writeFileSync(join(gateDirectory, `requested-${token}`), "pending", "utf8");
      while (!existsSync(join(gateDirectory, `release-${token}`))) await sleep(10);
      respond(id, type, captured);
      return;
    }
    case "set_subagent_subscription":
      if (!["off", "progress", "events"].includes(command.level)) {
        respondError(id, type, "Invalid subagent subscription level");
        return;
      }
      subagentSubscription = command.level;
      respond(id, type, { level: subagentSubscription });
      return;
    case "get_subagents":
      respond(id, type, { subagents: [...fakeSubagents.values()].map((agent) => agent.snapshot) });
      return;
    case "get_subagent_messages": {
      const { agent, data } = readSubagentMessages(command);
      respond(id, type, data);
      for (const resolveRead of agent.readWaiters.splice(0)) resolveRead();
      return;
    }
    case "cancel_subagent": {
      const agent = fakeSubagents.get(command.subagentId);
      const wakeBeforeReply = agent?.followUpOnCancel && !activeRun && !pumpTask;
      if (!wakeBeforeReply) respond(id, type, { cancelled: agent !== undefined });
      if (agent) {
        const message = { ...childAssistant(agent, "", undefined, "aborted"), errorMessage: "Subagent cancelled" };
        recordChildAssistant(agent, message, true);
        subagentEvent(agent, { type: "agent_end", messages: [message] });
        finishFakeSubagent(agent, "aborted");
        if (agent.followUpOnCancel) {
          const started = new Promise((resolveStart) => {
            followUp.push({
              type: "background", message: `Async result: ${agent.snapshot.id} aborted`, queued: false,
              holdForSteer: agent.holdFollowUp, onStarted: resolveStart,
            });
          });
          startPump();
          if (wakeBeforeReply) {
            await started;
            respond(id, type, { cancelled: true });
          }
        } else if (agent.asyncWake && !activeRun && !pumpTask && followUp.length === 0 &&
          ![...fakeSubagents.values()].some((child) => child.asyncWake)) {
          applyFinalLeaf();
          event({ type: "session_settled" });
        }
      }
      return;
    }
    case "steer_subagent": {
      const agent = fakeSubagents.get(command.subagentId);
      if (!agent) { respondError(id, type, `No running subagent ${command.subagentId}`); return; }
      appendSubagentMessage(agent, { role: "user", content: command.message, timestamp: ++agent.timestamp });
      respond(id, type);
      recordChildAssistant(agent, childAssistant(agent, `Steered ${agent.snapshot.id}: ${command.message}`), true);
      emitSubagentProgress(agent);
      agent.holdRun?.releaseHold?.("subagent-control");
      return;
    }
    case "get_available_models":
      respond(id, type, { models: loadAvailableModels() });
      if (process.env.FAKE_OMP_EXIT_AFTER_FIRST_AVAILABLE === "1" && spawnIndex === 1) setTimeout(() => exit(), 25);
      return;
    case "set_event_filter":
      eventFilter = command.events;
      messageUpdates = command.messageUpdates ?? "full";
      respond(id, type, { events: eventFilter, messageUpdates });
      return;
    case "set_ask_dialog": respond(id, type, { enabled: command.enabled === true }); return;
    case "get_available_commands": respond(id, type, { commands: availableCommands }); return;
    case "set_session_name": {
      const name = command.name.trim();
      if (!name) { respondError(id, type, "Session name cannot be empty"); return; }
      title = name;
      persistSession();
      respond(id, type);
      return;
    }
    case "get_available_thinking_levels": respond(id, type, { levels: ["off", ...(model.thinking?.efforts ?? [])] }); return;
    case "set_host_tools": {
      const tools = command.tools.map((tool, index) => {
        const name = typeof tool.name === "string" ? tool.name.trim() : "";
        const description = typeof tool.description === "string" ? tool.description.trim() : "";
        if (!name) throw new Error(`Host tool at index ${index} must provide a non-empty name`);
        if (!description) throw new Error(`Host tool "${name}" must provide a non-empty description`);
        if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
        return { ...tool, name, label: tool.label?.trim() || name, description };
      });
      hostTools.clear();
      for (const tool of tools) {
        hostTools.set(tool.name, tool);
        if (process.env.FAKE_OMP_TOOLS_DUMP) appendFileSync(process.env.FAKE_OMP_TOOLS_DUMP, `${JSON.stringify(tool)}\n`);
      }
      respond(id, type, { toolNames: [...hostTools.keys()] });
      return;
    }
    case "set_model": {
      const found = findModel(command.provider, command.modelId);
      if (!found) { respondError(id, type, `Model not found: ${command.provider}/${command.modelId}`); return; }
      model = found;
      appendEntry("model_change", { model: `${model.provider}/${model.id}` });
      event({ type: "model_changed" });
      respond(id, type, model);
      return;
    }
    case "set_thinking_level":
      configuredThinkingLevel = command.level;
      thinkingLevel = command.level;
      appendEntry("thinking_level_change", { thinkingLevel });
      event({ type: "thinking_level_changed", thinkingLevel });
      respond(id, type);
      return;
    case "set_fast_mode":
      fastModeEnabled = command.enabled;
      respond(id, type, {
        enabled: fastModeEnabled,
        active: fastModeEnabled && process.env.FAKE_OMP_FAST_MODE_INACTIVE !== "1",
      });
      return;
    case "set_steering_mode":
      nativeSessionControls.steeringMode = command.mode;
      respond(id, type);
      return;
    case "set_follow_up_mode":
      nativeSessionControls.followUpMode = command.mode;
      respond(id, type);
      return;
    case "set_interrupt_mode":
      nativeSessionControls.interruptMode = command.mode;
      respond(id, type);
      return;
    case "set_auto_compaction":
      nativeSessionControls.autoCompactionEnabled = command.enabled;
      respond(id, type);
      return;
    case "set_auto_retry":
      nativeSessionControls.autoRetryEnabled = command.enabled;
      respond(id, type);
      return;
    case "set_cache_warming":
      nativeSessionControls.cacheWarmingMode = command.mode;
      respond(id, type, { mode: nativeSessionControls.cacheWarmingMode });
      return;
    case "set_slow_mode":
      if (!slowModeSupported) {
        respondError(id, type, "Slow mode is not supported by the active model.");
        return;
      }
      nativeSessionControls.slowModeEnabled = command.enabled;
      if (command.enabled && slowModeScope === "session") fastModeEnabled = false;
      respond(id, type, { enabled: nativeSessionControls.slowModeEnabled });
      return;
    case "goal": {
      if (command.op === "create") {
        if (goalState?.enabled || goalState?.goal.status === "paused") {
          respondError(id, type, "A goal is already active or paused.");
          return;
        }
        if (!command.objective?.trim()) {
          respondError(id, type, "objective is required when op=create");
          return;
        }
        if (command.token_budget !== undefined && (!Number.isInteger(command.token_budget) || command.token_budget <= 0)) {
          respondError(id, type, "token_budget must be a positive integer when provided");
          return;
        }
        const now = Date.now();
        goalState = {
          enabled: true, mode: "active",
          goal: {
            id: randomUUID(), objective: command.objective.trim(), status: "active",
            ...(command.token_budget === undefined ? {} : { tokenBudget: command.token_budget }),
            tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now,
          },
        };
        event({ type: "goal_updated", goal: goalState.goal, state: goalState });
      } else if (command.op === "pause" && goalState) {
        goalState.enabled = false;
        if (["active", "budget-limited"].includes(goalState.goal.status)) goalState.goal.status = "paused";
        goalState.goal.updatedAt = Date.now();
        event({ type: "goal_updated", goal: goalState.goal, state: goalState });
      } else if (command.op === "resume") {
        if (goalState?.goal.status !== "paused" && !goalState?.enabled) {
          respondError(id, type, "No paused goal to resume.");
          return;
        }
        goalState.enabled = true;
        goalState.goal.status = "active";
        goalState.goal.updatedAt = Date.now();
        event({ type: "goal_updated", goal: goalState.goal, state: goalState });
      } else if (command.op === "drop" && goalState) {
        const dropped = { ...goalState.goal, status: "dropped", updatedAt: Date.now() };
        event({ type: "goal_updated", goal: dropped, state: { ...goalState, enabled: false, goal: dropped } });
        goalState = null;
      }
      respond(id, type, { goal: goalState?.goal ?? null, state: goalState });
      return;
    }
    case "get_session_stats": {
      const messages = branchEntries().filter((entry) => entry.type === "message").map((entry) => entry.message);
      const assistantUsage = messages.filter((message) => message.role === "assistant").map((message) => message.usage);
      const sumUsage = (field) => assistantUsage.reduce((sum, usage) => sum + (usage?.[field] ?? 0), 0);
      respond(id, type, {
        sessionFile, sessionId: header.id,
        userMessages: messages.filter((message) => message.role === "user").length,
        assistantMessages: messages.filter((message) => message.role === "assistant").length,
        toolCalls: hostCallCounter,
        toolResults: messages.filter((message) => message.role === "toolResult").length,
        totalMessages: messages.length,
        tokens: {
          input: sumUsage("input"), output: sumUsage("output"), reasoning: sumUsage("reasoningTokens"),
          cacheRead: sumUsage("cacheRead"), cacheWrite: sumUsage("cacheWrite"), total: sumUsage("totalTokens"),
        },
        premiumRequests: sumUsage("premiumRequests"),
        cost: assistantUsage.reduce((sum, usage) => sum + (usage?.cost?.total ?? 0), 0),
        contextUsage: { tokens, contextWindow: model.contextWindow, percent: 0 },
      });
      return;
    }
    case "prompt": admitPrompt(command); return;
    case "steer": queueSteering(command); return;
    case "follow_up":
      followUp.push({ ...command, queued: true });
      queueUpdate();
      respond(id, type);
      startPump();
      return;
    case "remove_queued_message": {
      if (process.env.FAKE_OMP_QUEUE_EDIT_FAILURE === "1") { respondError(id, type, "scripted queue edit failure"); return; }
      const queue = command.queue === "steering" ? steering : followUp;
      const index = queue.findIndex((item) => item.message === command.message);
      const [removed] = index < 0 ? [] : queue.splice(index, 1);
      queueUpdate();
      respond(id, type, { removed: removed !== undefined, ...(removed?.images ? { images: removed.images } : {}) });
      return;
    }
    case "promote_queued_message": {
      if (process.env.FAKE_OMP_QUEUE_EDIT_FAILURE === "1") { respondError(id, type, "scripted queue edit failure"); return; }
      const index = followUp.findIndex((item) => item.message === command.message);
      const [promoted] = index < 0 ? [] : followUp.splice(index, 1);
      if (promoted) steering.push(promoted);
      queueUpdate();
      respond(id, type, { promoted: promoted !== undefined });
      const releaseFile = process.env.FAKE_OMP_PROMOTE_RELEASE_FILE;
      const run = activeRun;
      if (promoted && releaseFile && run?.releaseHold) {
        while (!run.aborted && !existsSync(releaseFile)) await sleep(10);
        if (!run.aborted) run.releaseHold?.("steer");
      }
      return;
    }
    case "abort_and_restore_queue": {
      const restored = { steering: [], followUp: [] };
      for (const [name, queue] of [["steering", steering], ["followUp", followUp]]) {
        restored[name] = queue.splice(0).map((item) => ({
          text: item.message, ...(item.images ? { images: item.images } : {}),
        }));
      }
      queueUpdate();
      cancelRun();
      if (pumpTask) await pumpTask;
      isStreaming = false;
      respond(id, type, { ...restored, ...JSON.parse(process.env.FAKE_OMP_RESTORE_QUEUE_FLAGS ?? "{}") });
      return;
    }
    case "abort_and_prompt":
      cancelRun();
      if (pumpTask) await pumpTask;
      admitPrompt(command);
      return;
    case "abort":
      cancelRun();
      if (pumpTask) await pumpTask;
      isStreaming = false;
      respond(id, type);
      return;
    case "compact": {
      if (isStreaming || activeRun) { respondError(id, type, "Cannot compact while streaming"); return; }
      isCompacting = true;
      await sleep(5);
      isCompacting = false;
      if (!entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
        respondError(id, type, "Nothing to compact (session too small)");
        return;
      }
      const result = { summary: "scripted summary", tokensBefore: tokens, firstKeptEntryId: leafId };
      appendEntry("compaction", result);
      respond(id, type, result);
      return;
    }
    case "get_messages":
      respond(id, type, { messages: branchEntries().filter((entry) => entry.type === "message").map((entry) => entry.message) });
      return;
    case "get_entries": {
      let selected = entries;
      if (command.since !== undefined) {
        const index = entries.findIndex((entry) => entry.id === command.since);
        if (index === -1) { respondError(id, type, `Unknown since entry: ${command.since}`, "unknown_since"); return; }
        selected = entries.slice(index + 1);
      }
      respond(id, type, { entries: selected, leafId });
      return;
    }
    case "btw":
      await runBtw(command);
      return;
    case "btw_cancel": {
      const cancelled = runningBtw !== undefined && (command.recordId === undefined || command.recordId === runningBtw.record.id);
      if (cancelled) finishBtw(runningBtw, { status: "cancelled" });
      respond(id, type, { cancelled });
      return;
    }
    case "get_btw_history":
      respond(id, type, { records: loadBtwRecords().toSorted((a, b) => b.createdAt - a.createdAt) });
      return;
    case "bash":
      await runBash(command);
      return;
    case "abort_bash":
      for (const run of bashRuns) run.cancelled = true;
      respond(id, type);
      return;
    case "get_login_providers":
      respond(id, type, { providers: fakeLoginProviders.map((provider) => ({
        ...provider, authenticated: fakeLogoutAccounts.some((account) => account.provider === provider.id),
      })) });
      return;
    case "login": {
      if (command.providerId === "secret-test") {
        respondError(id, type, "Secret-only provider login is not supported in RPC mode");
        return;
      }
      if (command.providerId === "oauth-error") {
        respondError(id, type, "scripted OAuth setup failed before opening a URL");
        return;
      }
      if (!fakeLoginProviders.some((provider) => provider.id === command.providerId)) {
        respondError(id, type, `Unknown login provider: ${command.providerId}`);
        return;
      }
      const loginId = ++loginCounter;
      await openDialog({
        id: `login-url-${loginId}`, method: "open_url",
        url: `https://login.example.test/authorize?provider=${command.providerId}`,
        launchUrl: "http://127.0.0.1:9231/callback",
      });
      const answer = await openDialog({
        id: `login-input-${loginId}`, method: "input",
        title: `Finish ${command.providerId} sign-in`,
        placeholder: "Paste authorization code", timeout: 600_000,
      });
      if (answer.cancelled || answer.value === "deny") {
        respondError(id, type, answer.cancelled ? "OAuth login cancelled" : "scripted OAuth login rejected");
        return;
      }
      fakeLogoutAccounts.push({
        credentialId: 20 + loginId, provider: command.providerId,
        label: "Signed-in account", detail: "signed-in@example.test", type: "oauth", active: true,
      });
      respond(id, type, { providerId: command.providerId });
      return;
    }
    case "get_logout_accounts":
      respond(id, type, { accounts: fakeLogoutAccounts.filter((account) =>
        command.providerId === undefined || account.provider === command.providerId,
      ) });
      return;
    case "logout": {
      const accountIndex = fakeLogoutAccounts.findIndex((account) =>
        account.credentialId === command.credentialId && account.provider === command.providerId,
      );
      if (!Number.isInteger(command.credentialId) || accountIndex === -1) {
        respondError(id, type, "An existing integer credentialId is required");
        return;
      }
      const [removed] = fakeLogoutAccounts.splice(accountIndex, 1);
      const remaining = fakeLogoutAccounts.find((account) => account.provider === removed.provider);
      respond(id, type, { remainingSource: remaining ? remaining.label : "environment variable FAKE_OMP_API_KEY" });
      return;
    }
    case "export_html": {
      const path = resolve(process.cwd(), command.outputPath ?? "fake-omp-export.html");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "<!doctype html><html><body><h1>OMP session export</h1></body></html>\n", "utf8");
      respond(id, type, { path });
      return;
    }
    case "get_tree": {
      const nodes = new Map(entries.map((entry) => [entry.id, { entry, children: [] }]));
      const tree = [];
      for (const node of nodes.values()) {
        const parent = nodes.get(node.entry.parentId);
        if (parent) parent.children.push(node);
        else tree.push(node);
      }
      respond(id, type, { tree, leafId });
      return;
    }
    case "get_branch_messages":
      respond(id, type, { messages: entries.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => ({ entryId: entry.id, text: messageText(entry.message.content) })) });
      return;
    case "fork":
    case "branch": {
      if (isStreaming || isCompacting || activeRun || backgroundPending || followUp.length) {
        respondError(id, type, "Session is busy; cannot fork the session", "session_busy");
        return;
      }
      if (!persisted) { respond(id, type, { cancelled: true }); return; }
      const selected = command.entryId === undefined ? undefined : entries.find((entry) => entry.id === command.entryId);
      if (command.entryId !== undefined && (selected?.type !== "message" || (type === "branch" && selected.message.role !== "user"))) {
        respondError(id, type, `Invalid entry ID for ${type === "fork" ? "forking" : "branching"}: ${command.entryId}`);
        return;
      }
      const source = sessionFile;
      const parent = type === "fork" && !selected ? header.id : source;
      const history = selected ? branchEntries(type === "branch" ? selected.parentId : forkLeaf(selected.id)) : entries;
      createSession(history, parent, source);
      restoreSessionState();
      respond(id, type, { cancelled: false, ...(type === "branch" ? { text: messageText(selected.message.content) } : {}) });
      return;
    }
    case "new_session":
      title = "";
      createSession([], command.parentSession);
      restoreSessionState();
      respond(id, type, { cancelled: false });
      return;
    case "switch_session":
      loadSession(resolve(command.sessionPath));
      restoreSessionState();
      respond(id, type, { cancelled: false });
      return;
    case "open_session": {
      if (!persisted) { respondError(id, type, "Session persistence is disabled"); return; }
      sessionDir = resolve(command.sessionDir);
      const current = newestNonemptySession(sessionDir);
      if (current) loadSession(current);
      else { title = ""; createSession(); }
      restoreSessionState();
      respond(id, type, { cancelled: false, resumed: Boolean(current), sessionId: header.id, sessionFile });
      return;
    }
    default: respondError(id, type, `Unknown command "${type}"`);
  }
}

function receive(command) {
  if (process.env.FAKE_OMP_COMMAND_LOG) appendFileSync(process.env.FAKE_OMP_COMMAND_LOG, `${command.type}\n`);
  if (process.env.FAKE_OMP_RPC_LOG) appendFileSync(process.env.FAKE_OMP_RPC_LOG, `${JSON.stringify(command)}\n`);
  if (command.type === "extension_ui_response") {
    if (process.env.FAKE_OMP_UI_LOG) appendFileSync(process.env.FAKE_OMP_UI_LOG, `${JSON.stringify(command)}\n`);
    const waiter = extensionUiWaiters.get(command.id);
    extensionUiWaiters.delete(command.id);
    waiter?.resolve(command);
    return;
  }
  if (command.type === "host_tool_update") {
    const waiter = hostToolWaiters.get(command.id);
    if (waiter && Array.isArray(command.partialResult?.content)) {
      event({ type: "tool_execution_update", toolCallId: waiter.toolCallId, toolName: waiter.toolName, args: waiter.args, partialResult: command.partialResult });
    }
    return;
  }
  if (command.type === "host_tool_result") {
    const waiter = hostToolWaiters.get(command.id);
    if (!waiter || !Array.isArray(command.result?.content)) return;
    hostToolWaiters.delete(command.id);
    const isError = command.isError === true;
    const result = isError
      ? { content: [{ type: "text", text: messageText(command.result.content).trim() || "Host tool execution failed" }], details: {} }
      : command.result;
    waiter.resolve({ result, isError });
    return;
  }
  void handle(command).catch((error) => {
    respondError(command.id, command.type, error instanceof Error ? error.message : String(error));
  });
}

function readLines(input, onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  input.on("data", (chunk) => {
    pending += decoder.write(chunk);
    for (;;) {
      const index = pending.indexOf("\n");
      if (index === -1) return;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      let command;
      try { command = JSON.parse(line); } catch { continue; }
      if (command && typeof command === "object") onLine(command);
    }
  });
}

if (process.env.FAKE_OMP_NATIVE_EVENTS_FILE && !args.includes("--no-session")) {
  const path = process.env.FAKE_OMP_NATIVE_EVENTS_FILE;
  let consumed = 0;
  watch(path, () => {
    const lines = readFileSync(path, "utf8").split("\n");
    while (consumed < lines.length - 1) {
      const line = lines[consumed++];
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.type === "goal_updated") {
        if (frame.goal === null || frame.goal.status === "dropped") goalState = null;
        else if (frame.state) goalState = frame.state;
        else if (goalState?.goal.id === frame.goal.id) goalState.goal = frame.goal;
      }
      if (frame.type === "config_update" && frame.sessionControls) {
        Object.assign(nativeSessionControls, frame.sessionControls);
      }
      if (frame.type === "config_update") {
        if (typeof frame.slowModeSupported === "boolean") {
          slowModeSupported = frame.slowModeSupported;
        }
        if (frame.slowModeScope === "session" || frame.slowModeScope === "global") {
          slowModeScope = frame.slowModeScope;
        }
      }
      event(frame);
    }
  });
}

seedFakeSubagents();
readLines(process.stdin, receive);
process.stdin.on("end", () => { if (!hangOnClose) exit(); });
process.stdin.on("close", () => { if (!hangOnClose) exit(); });
if (hangOnClose) setInterval(() => undefined, 60_000);
if (process.env.FAKE_OMP_NO_READY !== "1") {
  event({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: MAX_FRAME_BYTES, maxReassembledFrameBytes: MAX_REASSEMBLED_FRAME_BYTES });
  event({ type: "available_commands_update", commands: availableCommands });
  if (configuredThinkingLevel === "auto") {
    event({ type: "thinking_level_changed", thinkingLevel, configured: "auto", resolved: thinkingLevel });
  }
  if (process.env.FAKE_OMP_STARTUP_UI_JSON) {
    const spec = JSON.parse(process.env.FAKE_OMP_STARTUP_UI_JSON);
    if (Array.isArray(spec)) {
      for (const [index, request] of spec.entries()) {
        void openDialog({ id: `startup-ui-${index}`, ...request });
      }
    } else {
      void openDialog({ id: "startup-ui", ...spec });
    }
  }
}
if (process.env.FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE === "1") exit();
