import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionSource } from "./generated/extension-source";

// Runtime imports in omp-extension.ts must be represented here. Type-only imports
// cannot affect the emitted extension and intentionally do not invalidate it.
export const EXTENSION_INPUTS = ["omp-extension.ts", "schema.ts", "policy.ts", "files.ts", "bundle-extension.ts", "extension-bundle.ts", "package-lock.json"];
export function extensionFingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const path of EXTENSION_INPUTS) hash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
  return hash.digest("hex");
}
export function assertFreshExtension(): void {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = existsSync(join(directory, "omp-extension.ts")) ? directory : dirname(directory);
  const stamp = /^\/\/ continuity-source-sha256: ([a-f0-9]{64})\n/.exec(extensionSource)?.[1];
  if (stamp !== extensionFingerprint(root)) {
    throw new Error("Continuity embedded extension is stale. Run bun run build before deployment; bare bb plugin build does not regenerate it.");
  }
}
