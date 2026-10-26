import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createOmpModelContextWindowResolverFrom,
  type OmpModelContextWindowResolver,
} from "../delta-translation.js";
import type { OmpModelFilter } from "../model-curation.js";
import {
  buildOmpAvailableModels,
  toCanonicalOmpModelId,
  type OmpCatalogModel,
  type OmpModelCost,
  type OmpModelIdentity,
} from "../model-list.js";
import { resolveOmpModelPresets } from "../native-roots.js";
import {
  OmpRpcChild,
  OmpRpcChildExitedError,
  buildOmpChildEnv,
} from "./rpc-child.js";

interface OmpRpcModel {
  id: string;
  name?: string;
  provider: string;
  input?: unknown;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: unknown;
  thinking?: OmpCatalogModel["thinking"];
  serviceTiers?: unknown;
  cost?: unknown;
  identity?: unknown;
  int?: unknown;
  supportsTools?: unknown;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function toCost(value: unknown): OmpModelCost | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const cost = value as Record<string, unknown>;
  const input = finiteNumber(cost.input);
  const output = finiteNumber(cost.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = finiteNumber(cost.cacheRead);
  const cacheWrite = finiteNumber(cost.cacheWrite);
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function toIdentity(value: unknown): OmpModelIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const identity: OmpModelIdentity = {};
  for (const key of ["class", "family", "revision", "effort", "logicalId"] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string" && field !== "") identity[key] = field;
  }
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function toCatalogModel(model: OmpRpcModel): OmpCatalogModel | undefined {
  if (
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    typeof model.provider !== "string" ||
    model.provider.length === 0
  ) {
    return undefined;
  }
  return {
    id: model.id,
    input: Array.isArray(model.input)
      ? model.input.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    name: typeof model.name === "string" ? model.name : model.id,
    provider: model.provider,
    reasoning: model.reasoning === true,
    thinking: model.thinking,
    ...(Array.isArray(model.serviceTiers)
      ? {
          serviceTiers: model.serviceTiers.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    cost: toCost(model.cost),
    contextWindow: finiteNumber(model.contextWindow) ?? null,
    maxTokens: finiteNumber(model.maxTokens) ?? null,
    identity: toIdentity(model.identity),
    int: finiteNumber(model.int),
    supportsTools: typeof model.supportsTools === "boolean" ? model.supportsTools : undefined,
  };
}

export interface OmpCatalog {
  listModels(filter: OmpModelFilter): Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;
  rawModels(): Promise<OmpRpcModel[]>;
  probe(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const catalogsByEnvironment = new Map<string, Promise<OmpCatalog>>();

async function spawnCatalog(
  cwd: string,
  shellEnvOverrides: Record<string, string>,
  touch: () => void,
): Promise<OmpCatalog> {
  interface ModelSnapshot {
    raw: OmpRpcModel[];
    state: Record<string, unknown>;
  }
  interface CatalogChildGeneration {
    child: OmpRpcChild;
    reading: Promise<ModelSnapshot> | null;
  }

  let generation: CatalogChildGeneration | null = null;
  const activeGeneration = (): CatalogChildGeneration => {
    if (generation === null || generation.child.exited) {
      generation = {
        child: new OmpRpcChild({
          cwd,
          env: buildOmpChildEnv(shellEnvOverrides),
          args: ["--mode", "rpc", "--cwd", cwd, "--no-session"],
          onEvent: () => {},
          onExit: () => {},
          recordThreadId: null,
        }),
        reading: null,
      };
    }
    return generation;
  };
  const readState = async (
    active: CatalogChildGeneration,
  ): Promise<Record<string, unknown>> => {
    const data = await active.child.requestOk({ type: "get_state" });
    return typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : {};
  };
  const readModels = (
    active: CatalogChildGeneration,
  ): Promise<ModelSnapshot> => {
    active.reading ??= (async () => {
      // OMP awaits its background registry refresh and applies enabledModels
      // itself. Re-read that native catalog; no refresh extension is needed.
      const [data, state] = await Promise.all([
        active.child.requestOk({ type: "get_available_models" }),
        readState(active),
      ]);
      const models = (data as { models?: unknown } | undefined)?.models;
      touch();
      return {
        raw: Array.isArray(models)
          ? models.filter(
              (entry): entry is OmpRpcModel =>
                typeof entry === "object" && entry !== null,
            )
          : [],
        state,
      };
    })().finally(() => {
      active.reading = null;
    });
    return active.reading;
  };
  const fetchModels = async (): Promise<ModelSnapshot> => {
    const first = activeGeneration();
    try {
      return await readModels(first);
    } catch (error) {
      if (!(error instanceof OmpRpcChildExitedError)) {
        throw error;
      }
      return readModels(activeGeneration());
    }
  };
  const probe = async (): Promise<Record<string, unknown>> => {
    const state = await readState(activeGeneration());
    touch();
    return state;
  };
  const close = async (): Promise<void> => {
    const activeChild = generation?.child;
    if (activeChild === undefined) return;
    activeChild.kill();
    await activeChild.waitForExit();
  };
  try {
    await probe();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async listModels(filter) {
      const [{ raw, state }, { presets, modelRoles }] = await Promise.all([
        fetchModels(),
        resolveOmpModelPresets({
          homeDir: homedir(),
          cwd,
          env: { ...process.env, ...shellEnvOverrides },
        }).catch(() => ({ presets: [], modelRoles: {} })),
      ]);
      const models: OmpCatalogModel[] = [];
      for (const model of raw) {
        const catalogModel = toCatalogModel(model);
        if (catalogModel) {
          models.push(catalogModel);
        } else {
          process.stderr.write(
            `omp bridge: skipped an incomplete model from provider "${String(model.provider)}"\n`,
          );
        }
      }
      const model = state.model as
        | { provider?: unknown; id?: unknown }
        | null
        | undefined;
      return buildOmpAvailableModels({
        models,
        preferredDefaultId:
          typeof model?.provider === "string" && typeof model.id === "string"
            ? toCanonicalOmpModelId(model.provider, model.id)
            : undefined,
        filter,
        modelRoles,
        presets,
      });
    },
    rawModels: async () => (await fetchModels()).raw,
    probe,
    close,
  };
}

function catalogIdleMs(): number {
  const configured = Number(process.env.BB_OMP_CATALOG_IDLE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 60_000;
}
const catalogIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function touchCatalog(key: string): void {
  const existing = catalogIdleTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    catalogIdleTimers.delete(key);
    const catalog = catalogsByEnvironment.get(key);
    catalogsByEnvironment.delete(key);
    void catalog?.then((entry) => entry.close()).catch(() => undefined);
  }, catalogIdleMs());
  timer.unref?.();
  catalogIdleTimers.set(key, timer);
}

function catalogKey(cwd: string, shellEnvOverrides: Record<string, string>): string {
  return JSON.stringify([
    resolve(cwd),
    Object.entries(shellEnvOverrides)
      .filter(([name]) => name !== "BB_THREAD_ID" && !name.startsWith("BB_CONTINUITY_"))
      .sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

export function peekOmpCatalog(
  cwd: string,
  shellEnvOverrides: Record<string, string> = {},
): Promise<OmpCatalog> | null {
  return catalogsByEnvironment.get(catalogKey(cwd, shellEnvOverrides)) ?? null;
}

export function getOmpCatalog(
  cwd: string,
  shellEnvOverrides: Record<string, string> = {},
): Promise<OmpCatalog> {
  const key = catalogKey(cwd, shellEnvOverrides);
  const existing = catalogsByEnvironment.get(key);
  if (existing) {
    return existing;
  }
  // Sessionless probes must neither activate Continuity nor fragment the cache
  // by its per-thread runtime directory.
  const catalogEnv = Object.fromEntries(
    Object.entries(shellEnvOverrides).filter(
      ([name]) => name !== "BB_THREAD_ID" && !name.startsWith("BB_CONTINUITY_"),
    ),
  );
  const created = spawnCatalog(resolve(cwd), catalogEnv, () => touchCatalog(key)).catch(
    (error: unknown) => {
      catalogsByEnvironment.delete(key);
      throw error;
    },
  );
  catalogsByEnvironment.set(key, created);
  return created;
}

export async function closeAllOmpCatalogs(): Promise<void> {
  for (const [, timer] of catalogIdleTimers) {
    clearTimeout(timer);
  }
  catalogIdleTimers.clear();
  const catalogs = [...catalogsByEnvironment.values()];
  catalogsByEnvironment.clear();
  await Promise.all(
    catalogs.map((catalog) =>
      catalog.then((entry) => entry.close()).catch(() => undefined),
    ),
  );
}

export function createLiveContextWindowResolver(): {
  resolve: OmpModelContextWindowResolver;
  learn(models: readonly OmpRpcModel[]): void;
} {
  const known = new Map<string, OmpRpcModel>();
  let resolver = createOmpModelContextWindowResolverFrom([]);
  return {
    resolve: (lastAssistant) => resolver(lastAssistant),
    learn(models) {
      let changed = false;
      for (const model of models) {
        if (typeof model.contextWindow !== "number") {
          continue;
        }
        const key = `${model.provider}\0${model.id}`;
        if (!known.has(key)) {
          known.set(key, model);
          changed = true;
        }
      }
      if (changed) {
        resolver = createOmpModelContextWindowResolverFrom(
          [...known.values()].map((model) => ({
            id: model.id,
            provider: model.provider,
            contextWindow: model.contextWindow,
          })),
        );
      }
    },
  };
}
