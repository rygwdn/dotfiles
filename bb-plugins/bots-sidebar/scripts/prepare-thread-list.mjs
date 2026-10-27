import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "vendor/bb");
const output = path.join(root, ".generated/bb");
const adapter = path.join(root, "integration/thread-list-sdk");

// The upstream snapshot stays byte-exact. Only build-time import routing changes:
// shared UI is isolated from the bot plugin's older vendored UI, and native
// sidebar reads go through the bot-ownership filter.
await rm(output, { recursive: true, force: true });
async function generate(relative) {
  const directory = path.join(source, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) { await generate(name); continue; }
    if (!/\.(?:tsx?|css|json)$/.test(name)) continue;
    const destination = path.join(output, name);
    // Standalone plugins use the SDK's icon flavor, including relative shared-UI
    // imports that bypass the upstream tsconfig alias.
    let content = await readFile(path.join(source, name === "shared-ui/components/ui/icon.tsx" ? "icon.tsx" : name), "utf8");
    if (/\.tsx?$/.test(name)) {
      content = content.replace(/(["'])@\/([^"']+)\1/g, (_match, quote, specifier) => {
        const target = specifier === "components/ui/icon"
          ? path.join(output, "icon")
          : path.join(output, "shared-ui", specifier);
        let local = path.relative(path.dirname(destination), target).split(path.sep).join("/");
        if (!local.startsWith(".")) local = `./${local}`;
        return `${quote}${local}${quote}`;
      });
      if (relative.startsWith("thread-list")) {
        let local = path.relative(path.dirname(destination), adapter).split(path.sep).join("/");
        if (!local.startsWith(".")) local = `./${local}`;
        content = content.replace(/(["'])@get-bb\/plugin-sdk\/app\1/g, `$1${local}$1`);
      }
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}
await generate("thread-list");
await generate("shared-ui");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "icon.tsx"), await readFile(path.join(source, "icon.tsx")));
console.log("Prepared isolated builtin thread-list sources from vendor/bb.");
