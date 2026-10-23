import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { resolveOmpNativeRoots } from "./native-roots.js";
import { ompServicesHostMethods } from "./hub-contract.js";
import { createOmpServices } from "./hub/services.js";
import { closeAllOmpCatalogs, getOmpCatalog } from "./bridge/catalog.js";
import { toCanonicalOmpModelId } from "./model-list.js";
import { createOmpModelPresetsConfig } from "./model-presets-config.js";
import {
  ompModelPresetsHostMethods,
  type OmpPresetModelOption,
} from "./model-presets-contract.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const services = createOmpServices();
const presets = createOmpModelPresetsConfig({
  homeDir: homedir(),
  cwd: homedir(),
  env: process.env,
});

async function presetModels(): Promise<{
  models: OmpPresetModelOption[];
  catalogError?: string;
}> {
  try {
    const catalog = await getOmpCatalog(homedir());
    const models = (await catalog.rawModels())
      .filter((model) =>
        typeof model.provider === "string" && model.provider !== "" &&
        typeof model.id === "string" && model.id !== "")
      .map((model) => ({
        id: toCanonicalOmpModelId(model.provider, model.id),
        name: typeof model.name === "string" ? model.name : model.id,
        thinkingLevels: Array.isArray(model.thinking?.efforts)
          ? model.thinking.efforts.filter((level): level is string => typeof level === "string")
          : [],
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return { models };
  } catch (error) {
    return {
      models: [],
      catalogError: error instanceof Error ? error.message : String(error),
    };
  }
}

export default experimental_defineHostEntry({
  contract: {
    ...experimental_nativeRootsHostContract,
    ...ompServicesHostMethods,
    ...ompModelPresetsHostMethods,
  },
  handlers: {
    resolveNativeRoots: ({ cwd }) =>
      resolveOmpNativeRoots({ homeDir: homedir(), cwd, env: process.env }),
    listOmpServices: (input, { signal }) => services.listOmpServices(input, signal),
    readOmpServiceLogs: (input, { signal }) => services.readOmpServiceLogs(input, signal),
    controlOmpService: (input, { signal }) => services.controlOmpService(input, signal),
    listModelPresets: async () => {
      const [snapshot, catalog] = await Promise.all([presets.list(), presetModels()]);
      return { ...snapshot, ...catalog };
    },
    saveModelPreset: (input) => presets.save(input),
    deleteModelPreset: (input) => presets.delete(input),
  },
  dispose: async () => {
    services.dispose();
    await closeAllOmpCatalogs();
  },
});
