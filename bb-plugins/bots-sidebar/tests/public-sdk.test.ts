import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

it("uses the public SDK and declared packages without private BB imports", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // The byte-exact upstream UI archive includes public components we do not
  // bundle. Its own manifest documents those imports; private @bb imports are
  // still rejected unconditionally by the SDK scanner.
  const upstreamUi = JSON.parse(readFileSync(new URL("../vendor/bb/shared-ui/package.json", import.meta.url), "utf8"));
  const packages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...upstreamUi.dependencies, ...upstreamUi.devDependencies });
  const allowed = packages.map(name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/.*)?$`));
  const scan = experimental_scanPublicSdkOnly(root, { allow: [...allowed, /^@\/(?:components|lib|hooks)\/[\w/.-]+$/] });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
