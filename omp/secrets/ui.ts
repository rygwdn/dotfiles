import type { ExtensionAPI, ExtensionCommandContext, Theme, KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { addSecret } from "./manage";
import { config, load, type LoadedStore } from "./store";

import type * as TuiModule from "@oh-my-pi/pi-tui";

type Tui = typeof TuiModule;

type Catalog = LoadedStore["catalog"];
type Choice = "add" | `secret:${string}` | undefined;

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, (char) => {
    if (char === "\n") return "\n";
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function pathEnv(path: string): string | undefined {
  const parts = path.split("/");
  if (parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(part))) return;
  return `OMP_SECRET_${parts.join("_").replaceAll("-", "_").toUpperCase()}`;
}

class SecretPanel implements Component {
  #tui: Tui;
  #path: string;
  #value: string;
  #shown = false;
  #scroll = 0;
  #viewportRows = 1;
  #contentRows = 0;
  #done: (result: boolean) => void;
  #keybindings: KeybindingsManager;
  #theme: Theme;
  #closed = false;

  constructor(tui: Tui, path: string, value: string, theme: Theme, keybindings: KeybindingsManager, done: (result: boolean) => void) {
    this.#tui = tui;
    this.#path = path;
    this.#value = value;
    this.#theme = theme;
    this.#keybindings = keybindings;
    this.#done = done;
  }

  handleInput(data: string): void {
    if (this.#keybindings.matches(data, "app.interrupt") || this.#tui.matchesKey(data, "escape")) this.#close();
    else if (data === " " || this.#tui.matchesKey(data, "enter")) {
      this.#shown = !this.#shown;
      this.#scroll = 0;
    } else if (this.#tui.matchesKey(data, "up")) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (this.#tui.matchesKey(data, "down")) this.#scroll = Math.min(this.#maxScroll(), this.#scroll + 1);
    else if (this.#tui.matchesKey(data, "pageUp")) this.#scroll = Math.max(0, this.#scroll - this.#viewportRows);
    else if (this.#tui.matchesKey(data, "pageDown")) this.#scroll = Math.min(this.#maxScroll(), this.#scroll + this.#viewportRows);
  }

  render(width: number): readonly string[] {
    const header = [
      this.#theme.fg("accent", `Secret: ${this.#path}`),
      this.#shown ? "Revealed temporarily" : "Value masked",
      "",
    ];
    const valueRows = this.#shown
      ? safeText(this.#value).split("\n").flatMap((line) =>
          this.#tui.wrapTextWithAnsi(this.#tui.replaceTabs(line), Math.max(1, width)),
        )
      : ["••••••••"];
    this.#contentRows = valueRows.length;
    this.#viewportRows = Math.max(1, (process.stdout.rows ?? 24) - header.length - 2);
    this.#scroll = Math.min(this.#scroll, this.#maxScroll());
    return [
      ...header,
      ...valueRows.slice(this.#scroll, this.#scroll + this.#viewportRows),
      "",
      "Space / Enter: toggle reveal    ↑/↓: scroll    PgUp/PgDn: page    Esc: close (value cleared)",
    ].map((row) => this.#tui.truncateToWidth(this.#tui.replaceTabs(row), width));
  }

  dispose(): void {
    this.#close();
  }

  #maxScroll(): number {
    return Math.max(0, this.#contentRows - this.#viewportRows);
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#value = "";
    this.#done(false);
  }
}

class SecretEditor implements Component {
  #tui: Tui;
  #pasteActive = false;
  #pasteBuffer = "";
  #pasteStartPending = "";
  #pasteStartTimer: ReturnType<typeof setTimeout> | undefined;
  #inputs: InstanceType<Tui["Input"]>[] = [];
  #keybindings: KeybindingsManager;
  #done: (value: string | undefined) => void;
  #finished = false;

  constructor(tui: Tui, keybindings: KeybindingsManager, done: (value: string | undefined) => void) {
    this.#tui = tui;
    this.#keybindings = keybindings;
    this.#done = done;
    this.#addLine();
  }

  handleInput(data: string): void {
    if (this.#pasteActive) {
      const combined = this.#pasteBuffer + data;
      const endIndex = combined.indexOf(this.#tui.BRACKETED_PASTE_END);
      if (endIndex >= 0) {
        this.#appendPaste(combined.slice(0, endIndex));
        this.#pasteBuffer = "";
        this.#pasteActive = false;
        const remaining = combined.slice(endIndex + this.#tui.BRACKETED_PASTE_END.length);
        if (remaining) this.handleInput(remaining);
      } else if (combined.length > 64 * 1024 * 1024) {
        this.#finish(undefined);
      } else {
        this.#pasteBuffer = combined;
      }
      return;
    }

    const input = this.#pasteStartPending + data;
    this.#pasteStartPending = "";
    clearTimeout(this.#pasteStartTimer);
    this.#pasteStartTimer = undefined;
    const startIndex = input.indexOf(this.#tui.BRACKETED_PASTE_START);
    if (startIndex >= 0) {
      if (startIndex > 0) this.#handleKeys(input.slice(0, startIndex));
      this.#pasteActive = true;
      this.#pasteBuffer = "";
      this.handleInput(input.slice(startIndex + this.#tui.BRACKETED_PASTE_START.length));
      return;
    }

    let pendingLength = 0;
    const start = this.#tui.BRACKETED_PASTE_START;
    for (let length = 1; length <= Math.min(start.length - 1, input.length); length++) {
      if (input.endsWith(start.slice(0, length))) pendingLength = length;
    }
    const normalEnd = input.length - pendingLength;
    if (normalEnd > 0) this.#handleKeys(input.slice(0, normalEnd));
    if (pendingLength > 0) {
      this.#pasteStartPending = input.slice(normalEnd);
      this.#pasteStartTimer = setTimeout(() => {
        const pending = this.#pasteStartPending;
        this.#pasteStartPending = "";
        this.#pasteStartTimer = undefined;
        if (pending) this.#handleKeys(pending);
      }, 80);
    }
  }

  #appendPaste(value: string): void {
    // Bracketed paste payloads are secret bytes, not keyboard protocol.
    const input = this.#inputs.at(-1);
    if (input) input.setValue(input.getValue() + value);
  }

  #handleKeys(data: string): void {
    if (this.#keybindings.matches(data, "app.interrupt") || this.#tui.matchesKey(data, "escape")) {
      this.#finish(undefined);
      return;
    }
    if (data === "\u0013" || this.#tui.matchesKey(data, "ctrl+enter")) {
      this.#finish(this.#inputs.map((input) => input.getValue()).join("\n"));
      return;
    }
    if (data === "\n" || data === "\r" || this.#tui.matchesKey(data, "enter")) {
      this.#addLine();
      return;
    }
    this.#inputs.at(-1)?.handleInput(data);
  }

  render(width: number): readonly string[] {
    return [
      "Secret input (masked). Enter: new line    Ctrl+S / Ctrl+Enter: submit    Esc: cancel",
      ...this.#inputs.flatMap((input) => input.render(width)),
    ].map((row) => this.#tui.truncateToWidth(this.#tui.replaceTabs(row), width));
  }

  dispose(): void {
    clearTimeout(this.#pasteStartTimer);
    this.#pasteStartTimer = undefined;
    if (!this.#finished) this.#finish(undefined);
  }

  #addLine(): void {
    const input = new this.#tui.Input();
    input.prompt = "  ";
    input.mask = true;
    this.#inputs.push(input);
  }

  #finish(value: string | undefined): void {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#pasteStartTimer);
    this.#pasteStartTimer = undefined;
    this.#pasteStartPending = "";
    this.#pasteBuffer = "";
    for (const input of this.#inputs) input.setValue("");
    this.#inputs = [];
    this.#done(value);
  }
}

async function choose(pi: ExtensionAPI, ctx: ExtensionCommandContext, catalog: Catalog, tui: Tui): Promise<Choice> {
  return ctx.ui.custom<Choice>((_tui, theme, keybindings, done) => {
    const list = new tui.SelectList(
      [
        ...catalog.entries.map((entry) => ({ value: `secret:${entry.path}`, label: entry.path, description: entry.env })),
        { value: "add", label: "Add secret", description: "Create a new encrypted store entry" },
      ],
      10,
      pi.pi.getSelectListTheme(),
    );
    list.onSelect = (item) => done(item.value as Choice);
    list.onCancel = () => done(undefined);
    return {
      render: (width) => [
        theme.fg("accent", "/secrets"),
        `Store: ${catalog.source} snapshot · ${catalog.entries.length} entries · refreshed ${catalog.cachedAt}`,
        ...list.render(width),
        "↑/↓: browse    Enter: inspect/add    Esc: close",
      ].map((line) => tui.truncateToWidth(tui.replaceTabs(line), width)),
      handleInput: (data) => {
        if (keybindings.matches(data, "app.interrupt")) done(undefined);
        else list.handleInput(data);
      },
    };
  });
}

export function registerSecretUI(pi: ExtensionAPI, initialCatalog: Catalog, tui: Tui): void {
  let catalog: Catalog = { ...initialCatalog, entries: [...initialCatalog.entries] };

  pi.registerCommand("secrets", {
    description: "Browse, inspect, and add encrypted central secrets",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return;

      for (;;) {
        const choice = await choose(pi, ctx, catalog, tui);
        if (choice === undefined) return;
        if (choice === "add") {
          const path = await ctx.ui.input("Secret path", "e.g. services/api/token");
          if (path === undefined) return;
          const env = pathEnv(path);
          if (!env || path.length === 0 || path.includes("\0")) {
            ctx.ui.notify("Invalid secret path. Use slash-separated key segments with letters, digits, _ or -.", "error");
            continue;
          }
          if (catalog.entries.some((entry) => entry.env === env)) {
            ctx.ui.notify("A secret with that normalized environment key already exists.", "error");
            continue;
          }
          const cfg = config();
          if (cfg.offline) {
            ctx.ui.notify("Adding secrets is unavailable in offline mode.", "warning");
            continue;
          }
          let value = await ctx.ui.custom<string | undefined>((_tui, _theme, keybindings, done) =>
            new SecretEditor(tui, keybindings, done),
          );
          if (value === undefined) continue;
          if (value.length < 8 || value.includes("\0")) {
            value = "";
            ctx.ui.notify("Secret must be at least 8 characters and contain no NUL.", "error");
            continue;
          }
          const destination = `${cfg.host}:${cfg.store} → ${path} (${env})`;
          const approved = await ctx.ui.confirm("Confirm secret destination", `Add a secret to ${destination}?`);
          if (!approved) {
            value = "";
            continue;
          }
          try {
            const updated = await addSecret(cfg, path, value);
            catalog = { ...updated.catalog, entries: [...updated.catalog.entries] };
            ctx.ui.notify(`Secret added at ${path} (${env}). Restart OMP to make it available to the agent.`, "info");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : "Central store update could not be confirmed; inspect /secrets before retrying", "error");
          } finally {
            value = "";
          }
          continue;
        }

        const path = choice.slice("secret:".length);
        let snapshot: LoadedStore | undefined;
        let value: string | undefined;
        try {
          snapshot = await load(config());
          const entry = snapshot.catalog.entries.find((candidate) => candidate.path === path);
          value = entry ? snapshot.values[entry.env] : undefined;
          catalog = { ...snapshot.catalog, entries: [...snapshot.catalog.entries] };
          if (!entry || value === undefined) {
            ctx.ui.notify(`Secret ${path} is unavailable in the current store snapshot.`, "warning");
            continue;
          }
          await ctx.ui.custom<boolean>((_runtimeTui, theme, keybindings, done) =>
            new SecretPanel(tui, path, value, theme, keybindings, done),
          );
        } catch {
          ctx.ui.notify(`Could not inspect secret ${path}.`, "error");
        } finally {
          value = undefined;
          if (snapshot) {
            for (const key of Object.keys(snapshot.values)) snapshot.values[key] = "";
          }
        }
      }

    },
  });
}
