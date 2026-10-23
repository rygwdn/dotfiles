import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerUsageResultSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { OMP_BRIDGE_ARGS_ENV, OMP_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { getOmpProviderUsage, mapOmpProviderUsage } from "./provider-maintenance.js";

afterEach(() => vi.unstubAllEnvs());

function limit(amount: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { id: "primary", label: "Primary", scope: { provider: "anthropic" }, amount, ...overrides };
}

function report(limits: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    provider: "anthropic",
    fetchedAt: 1_700_000_000_000,
    metadata: { email: "alice@example.com", accountId: "account-a", planType: "Max" },
    limits,
    ...overrides,
  };
}

function windows(reports: unknown[]) {
  const usage = mapOmpProviderUsage({ reports });
  if (usage.status !== "ok") throw new Error("Expected successful usage mapping");
  expect(providerUsageResultSchema.safeParse({ supported: true, usage }).success).toBe(true);
  return usage.windows;
}

function configureNodeProbe(script: string): void {
  vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, process.execPath);
  vi.stubEnv(OMP_BRIDGE_ARGS_ENV, JSON.stringify(["-e", script, "--"]));
}

describe("OMP account usage mapping", () => {
  it("keeps multiple providers, accounts and limit windows separate with scoped labels", () => {
    const reset = 1_800_000_000_000;
    const usage = mapOmpProviderUsage({ reports: [
      report([
        limit({ unit: "percent", used: 25 }, { window: { id: "5h", label: "5 Hour", resetsAt: reset } }),
        limit({ unit: "tokens", used: 2, limit: 10 }, { label: "Weekly", window: { id: "7d", label: "7 Day" } }),
      ]),
      report([limit({ unit: "percent", used: 60 })], {
        metadata: { email: "alice@example.com", accountId: "account-b", planType: "Pro" },
      }),
      report([limit({ unit: "requests", used: 3, limit: 4 }, {
        scope: { provider: "openai", projectId: "project-c", modelId: "codex" },
      })], { provider: "openai", metadata: { email: "bob@example.com", planType: "Business" } }),
    ] });
    expect(usage).toEqual({
      status: "ok", accountEmail: null, planLabel: null,
      windows: [
        { label: "anthropic · alice@example.com · account-a · Max · Primary · 5 Hour", usedPercent: 25, resetsAt: new Date(reset).toISOString() },
        { label: "anthropic · alice@example.com · account-a · Max · Weekly · 7 Day", usedPercent: 20, resetsAt: null },
        { label: "anthropic · alice@example.com · account-b · Pro · Primary", usedPercent: 60, resetsAt: null },
        { label: "openai · bob@example.com · project-c · Business · codex · Primary", usedPercent: 75, resetsAt: null },
      ],
    });
  });

  it("follows native fraction precedence and clamps underuse and overage to SDK bounds", () => {
    const result = windows([report([
      limit({ unit: "percent", usedFraction: 0.2, used: 80, limit: 100, remainingFraction: 0.1 }),
      limit({ unit: "percent", used: 30, limit: 60, remainingFraction: 0.1 }),
      limit({ unit: "percent", used: 45, remainingFraction: 0.1 }),
      limit({ unit: "tokens", remainingFraction: 0.25 }),
      limit({ unit: "requests", used: 200, limit: 100 }),
      limit({ unit: "percent", usedFraction: -0.2 }),
      limit({ unit: "tokens", remainingFraction: 2 }),
    ])]);
    expect(result.map((window) => window.usedPercent)).toEqual([20, 50, 45, 75, 100, 0, 0]);
  });

  it("does not turn missing quantities or unusable ratios into zero usage", () => {
    expect(windows([report([
      limit({ unit: "tokens" }),
      limit({ unit: "tokens", remaining: 50, limit: 100 }),
      limit({ unit: "requests", used: 10, limit: 0 }),
      limit({ unit: "tokens", used: Number.MAX_VALUE, limit: Number.MIN_VALUE }),
    ])])).toEqual([]);
  });

  it("exposes cost only for meaningful complete USD amounts, rounded to integer cents", () => {
    const result = windows([report([
      limit({ unit: "usd", used: 1.235, limit: 12.345 }),
      limit({ unit: "usd", usedFraction: 0.5, limit: 10 }),
      limit({ unit: "usd", usedFraction: 0.5, used: 10 }),
      limit({ unit: "credits", used: 2, limit: 10 }),
      limit({ unit: "usd", used: -1, limit: 10 }),
      limit({ unit: "usd", usedFraction: 1, used: Number.MAX_VALUE, limit: Number.MAX_VALUE }),
      limit({ unit: "usd", usedFraction: 1, used: 0.001, limit: 0.001 }),
    ])]);
    expect(result[0]?.cost).toEqual({ usedUsdCents: 124, limitUsdCents: 1235 });
    expect(result.slice(1).every((window) => window.cost === undefined)).toBe(true);
  });

  it("uses null for absent or unrepresentable reset times", () => {
    const result = windows([report([
      limit({ unit: "percent", used: 1 }),
      limit({ unit: "percent", used: 2 }, { window: { id: "monthly", label: "Monthly" } }),
      limit({ unit: "percent", used: 3 }, { window: { id: "bad", label: "Invalid", resetsAt: Number.MAX_VALUE } }),
    ])]);
    expect(result.map((window) => window.resetsAt)).toEqual([null, null, null]);
  });

  it("publishes identity and plan only when every reported account agrees", () => {
    const first = report([limit({ unit: "percent", used: 10 })]);
    expect(mapOmpProviderUsage({ reports: [first] })).toMatchObject({ accountEmail: "alice@example.com", planLabel: "Max" });
    expect(mapOmpProviderUsage({ reports: [first, first] })).toMatchObject({ accountEmail: "alice@example.com", planLabel: "Max" });
    expect(mapOmpProviderUsage({ reports: [first, report([], { metadata: {} })] })).toMatchObject({ accountEmail: null, planLabel: null });
    expect(mapOmpProviderUsage({ reports: [first], accountsWithoutUsage: [{ provider: "openai", email: "bob@example.com" }] })).toMatchObject({ accountEmail: null, planLabel: null });
  });

  it("uses provider and numbered account labels when identity is unavailable", () => {
    expect(windows([
      report([limit({ unit: "percent", used: 1 })], { metadata: {} }),
      report([limit({ unit: "percent", used: 2 })], { metadata: {} }),
    ]).map((window) => window.label)).toEqual([
      "anthropic · account 1 · Primary", "anthropic · account 2 · Primary",
    ]);
  });

  it("accepts no reports, unsupported accounts and disabled credentials without inventing auth failures", () => {
    expect(mapOmpProviderUsage({
      generatedAt: 1_700_000_000_000, reports: [],
      accountsWithoutUsage: [{ provider: "custom" }],
      disabledCredentials: [{ provider: "anthropic", reason: "expired" }], capacity: {},
    })).toEqual({ status: "ok", accountEmail: null, planLabel: null, windows: [] });
  });

  it.each([null, [], {}, { reports: {} }, { reports: [null] }, { reports: [report([{ label: "broken" }])] }, { reports: [report([limit({ unit: "percent", used: "50" })])] }])(
    "rejects malformed report output %#", (value) => {
      expect(() => mapOmpProviderUsage(value)).toThrow("malformed reports");
    },
  );
});

describe("OMP sessionless usage probe", () => {
  it("uses configured executable/args and cwd, ignores stderr warnings and does not start RPC", async () => {
    const cwd = path.join(process.cwd(), "src");
    const output = { reports: [report([limit({ unit: "percent", used: 42 })])] };
    configureNodeProbe(`
      if (JSON.stringify(process.argv.slice(1)) !== '["usage","--json"]') process.exit(2);
      if (process.cwd() !== ${JSON.stringify(cwd)}) process.exit(3);
      process.stderr.write("Warning: plugin warning\\n");
      process.stdout.write(${JSON.stringify(JSON.stringify(output))});
    `);
    expect(await getOmpProviderUsage({ cwd })).toEqual({ supported: true, usage: mapOmpProviderUsage(output) });
  });

  it("returns successful empty windows for the observed empty CLI report", async () => {
    configureNodeProbe('process.stdout.write(JSON.stringify({generatedAt: Date.now(), reports: [], accountsWithoutUsage: [], disabledCredentials: [], capacity: {}}));');
    expect(await getOmpProviderUsage()).toEqual({
      supported: true, usage: { status: "ok", accountEmail: null, planLabel: null, windows: [] },
    });
  });

  it("reports a missing configured binary as not installed", async () => {
    vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, path.join(process.cwd(), "missing-omp-usage-binary"));
    vi.stubEnv(OMP_BRIDGE_ARGS_ENV, "[]");
    expect(await getOmpProviderUsage()).toEqual({ supported: true, usage: { status: "not_installed" } });
  });

  it.each([
    ['process.stdout.write("not JSON");', "invalid JSON"],
    ['process.stdout.write("{}");', "malformed reports"],
    ['process.stderr.write("{\\"reports\\":[]}");', "invalid JSON"],
    ['process.stdout.write("{\\"reports\\":[]}"); process.exit(2);', "exited with 2"],
  ])("returns a usage error for failed or malformed CLI responses %#", async (script, message) => {
    configureNodeProbe(script);
    expect(await getOmpProviderUsage()).toEqual({
      supported: true,
      usage: { status: "error", message: expect.stringContaining(message), accountEmail: null, planLabel: null },
    });
  });
});
