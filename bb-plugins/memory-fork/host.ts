import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { ompCutoverHostContract } from "./omp-cutover-contract.js";

export default experimental_defineHostEntry({
  contract: ompCutoverHostContract,
  handlers: {
    async prepareOmpMemoryOverlay(_input, { experimental_paths: paths }) {
      await mkdir(paths.dataDir, { recursive: true });
      const file = join(paths.dataDir, "bb-memory-overlay.json");
      // Preserve managed-skill tools; suppress only the private native capture
      // turn. Backend off removes retain/recall/reflect/edit.
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({
          memory: { backend: "off" },
          autolearn: { autoContinue: false },
        }), { encoding: "utf8", flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      const inherited = (process.env.PI_CONFIG_FILES ?? "").split(delimiter).filter(Boolean);
      return { configFiles: [...inherited.filter(path => path !== file), file].join(delimiter) };
    },
  },
});
