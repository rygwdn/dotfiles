import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
// Standalone OMP resolves bundled runtime imports at the extension entry point.
import * as tui from "@oh-my-pi/pi-tui";
import { config, load, type LoadedStore } from "./store";
import { registerSecretUI } from "./ui";

type SecretCatalog = LoadedStore["catalog"];

function ageLabel(cachedAt: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(cachedAt));
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default async function secretsExtension(pi: ExtensionAPI): Promise<void> {
  const enabled = lookup("secrets.enabled");
  if (!enabled) {
    throw new Error("The secrets.enabled runtime setting is unavailable; use OMP 18.4.4 or newer.");
  }
  enabled.override(pi.pi.settings, true);

  // The CLI awaits factories before building its obfuscator. Subagent/reload
  // factories reuse this process snapshot rather than rotating live credentials.
  if (process.env.OMP_SECRETS_READY !== "1") {
    const loaded = await load(config());
    for (const name of Object.keys(process.env)) {
      // Native shells overlay JS env onto their inherited OS env; deletion alone
      // would leave an inherited credential live. Explicit empty values clear it.
      if (name.startsWith("OMP_SECRET_")) process.env[name] = "";
    }
    Object.assign(process.env, loaded.values);
    process.env.OMP_SECRETS_CATALOG = JSON.stringify(loaded.catalog);
    process.env.OMP_SECRETS_READY = "1";
  }
  const rawCatalog = process.env.OMP_SECRETS_CATALOG;
  if (!rawCatalog) throw new Error("Secret startup catalog is missing; restart OMP.");

  const schema = pi.zod.object({
    source: pi.zod.enum(["remote", "cache"]),
    cachedAt: pi.zod.string(),
    entries: pi.zod.array(
      pi.zod.object({
        path: pi.zod.string().regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/i),
        env: pi.zod.string().regex(/^OMP_SECRET_[A-Z0-9][A-Z0-9_]*$/),
      }),
    ),
  });

  function parseCatalog(value: unknown): SecretCatalog {
    const candidate = schema.parse(value) as SecretCatalog;
    if (!candidate.entries.length || !Number.isFinite(Date.parse(candidate.cachedAt))) throw new Error("catalog timestamp or entries are invalid");
    const paths = new Set<string>();
    const envs = new Set<string>();
    for (const entry of candidate.entries) {
      const canonicalEnv = `OMP_SECRET_${entry.path.replace(/[/-]/g, "_").toUpperCase()}`;
      if (entry.env !== canonicalEnv) throw new Error("entry env does not match its canonical path name");
      if (paths.has(entry.path) || envs.has(entry.env)) throw new Error("catalog contains duplicate entry metadata");
      paths.add(entry.path);
      envs.add(entry.env);
      const secret = process.env[entry.env];
      if (typeof secret !== "string" || secret.length < 8) {
        throw new Error(`startup secret ${entry.env} is missing or shorter than 8 characters`);
      }
    }
    return candidate;
  }

  let catalog: SecretCatalog;
  try {
    catalog = parseCatalog(JSON.parse(rawCatalog));
  } catch {
    throw new Error("Secret startup catalog is invalid; restart OMP.");
  }

  const metadata = (prefix?: string) => ({
    source: catalog.source,
    cachedAt: catalog.cachedAt,
    entries: catalog.entries
      .filter((entry) => !prefix || entry.path.startsWith(prefix))
      .map(({ path, env }) => ({ path, env })),
  });

  pi.registerTool({
    name: "secrets",
    label: "Secret metadata",
    description:
      "List secret metadata only (logical paths and canonical environment-variable names); never returns secret values. " +
      "Use the shell with $OMP_SECRET_HOMELAB_BOOKORBIT_API_KEY to access a value. References such as " +
      "secrets://homelab/bookorbit/api_key are human logical references only, not readable files or an IO protocol.",
    parameters: pi.zod.object({ prefix: pi.zod.string().optional() }),
    async execute(_toolCallId, params) {
      if (enabled.get(pi.pi.settings) !== true) {
        return { content: [{ type: "text", text: "Secret access is disabled for this session." }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(metadata(params.prefix)) }] };
    },
  });

  pi.on("tool_call", () => {
    if (enabled.get(pi.pi.settings) !== true) {
      return { block: true, reason: "Secret redaction must remain enabled; restart OMP." };
    }
  });

  pi.on("before_agent_start", () => ({
    message: {
      customType: "omp-secrets-guidance",
      content: "Secrets are available through startup-injected environment variables. Use the secrets tool for metadata only; " +
        "access a value in shell commands through its canonical $OMP_SECRET_* variable. Human references such as " +
        "secrets://homelab/bookorbit/api_key are labels only, not an IO mechanism. Never request, print, or disclose secret values. " +
        "The startup redactor is fixed for this process; restart OMP to refresh secrets.",
      display: false,
      attribution: "agent",
    },
  }));

  pi.on("session_start", (_event, ctx) => {
    if (catalog.source === "cache" && ctx.hasUI) {
      ctx.ui.notify(`Secrets: offline snapshot from ${catalog.cachedAt} (${ageLabel(catalog.cachedAt)} old).`, "warning");
    }
  });
  registerSecretUI(pi, catalog, tui);
}
