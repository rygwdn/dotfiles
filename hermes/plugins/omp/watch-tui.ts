import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { TUI, type Component } from "@oh-my-pi/pi-tui/tui";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { WatchTranscript } from "./watch-view";

const [python, cli, worker] = process.argv.slice(2);
if (!python || !cli || !worker || !process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Use cli.py watch WORKER --tui in an interactive terminal.");
  process.exit(1);
}
await initTheme();
const terminal = new ProcessTerminal();
const tui = new TUI(terminal, false);
let scrollTop: number | undefined;
let finished = false;
let failure = "";
let rows: string[] | undefined;
let cachedWidth = 0;
const repaint = () => { rows = undefined; tui.requestRender(); };
const transcript = new WatchTranscript({
  requestRender: repaint,
  requestComponentRender: repaint,
  resetDisplay: repaint,
});
let end!: () => void;
const done = new Promise<void>(resolve => { end = resolve; });
const viewport: Component = {
  invalidate() {
    rows = undefined;
    for (const block of transcript.blocks) block.invalidate();
  },
  render(width) {
    if (!rows || width !== cachedWidth) {
      rows = transcript.blocks.flatMap(block => [...block.render(width), ""]);
      cachedWidth = width;
    }
    const height = Math.max(1, terminal.rows - 2);
    const maxTop = Math.max(0, rows.length - height);
    if (scrollTop !== undefined) scrollTop = Math.min(scrollTop, maxTop);
    const top = scrollTop ?? maxTop;
    const visible = rows.slice(top, top + height);
    while (visible.length < height) visible.push("");
    const state = failure || (finished ? "Journal ended" : transcript.state);
    return [
      ...visible,
      truncateToWidth(`READ ONLY · ${worker} · ${Bun.stripANSI(state)} · ${scrollTop === undefined ? "following" : "scrollback"}`, width),
      truncateToWidth("↑/↓ scroll · PgUp/PgDn page · End/f follow · o expand tools · q quit", width),
    ];
  },
  handleInput(data) {
    const maxTop = Math.max(0, (rows?.length ?? 0) - Math.max(1, terminal.rows - 2));
    const top = scrollTop ?? maxTop;
    if (matchesKey(data, "q") || matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) end();
    else if (matchesKey(data, "up")) scrollTop = Math.max(0, top - 1);
    else if (matchesKey(data, "down")) scrollTop = Math.min(maxTop, top + 1);
    else if (matchesKey(data, "pageUp")) scrollTop = Math.max(0, top - Math.max(1, terminal.rows - 3));
    else if (matchesKey(data, "pageDown")) scrollTop = Math.min(maxTop, top + Math.max(1, terminal.rows - 3));
    else if (matchesKey(data, "home")) scrollTop = 0;
    else if (matchesKey(data, "end") || matchesKey(data, "f")) scrollTop = undefined;
    else if (matchesKey(data, "o")) transcript.toggleExpanded();
    tui.requestRender();
  },
};
tui.addChild(viewport);
tui.setFocus(viewport);
// The existing Python client owns socket validation, pagination, and errors.
// No RPC, prompt, answer, resume, or session-file APIs are available to this viewer.
const feed = spawn(python, [cli, "--json", "watch", worker], { stdio: ["ignore", "pipe", "pipe"] });
const input = createInterface({ input: feed.stdout });
input.on("line", line => {
  try {
    const event = JSON.parse(line);
    transcript.apply(event.seq, event.frame);
  } catch (error) {
    failure = `Viewer error: ${String(error)}`;
    feed.kill("SIGTERM");
    repaint();
  }
});
feed.stderr.setEncoding("utf8");
feed.stderr.on("data", chunk => { failure = (failure + chunk).slice(-2000).trim(); repaint(); });
feed.on("error", error => { failure = error.message; finished = true; repaint(); });
feed.on("exit", () => { finished = true; repaint(); });
process.once("SIGTERM", end);
process.once("SIGINT", end);
try {
  tui.start();
  await done;
} finally {
  input.close();
  feed.kill("SIGTERM");
  transcript.dispose();
  tui.stop();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
