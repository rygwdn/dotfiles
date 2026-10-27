/**
 * Classification is the safety model, so it gets the most tests.
 *
 * Command lines here are verbatim from `ps` on a machine running a BB fleet.
 * The cases that matter are the near-misses: the user's own Chrome next to a
 * Playwright one, a renderer child next to its parent, an agent next to a test
 * runner. A mistake in either direction is a real cost — a false `system` hides
 * a leak, a false `browser-automation` kills someone's browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, isAutomationBrowser, parseEtime, parsePort, parseThreadId, processName } from "../lib/procs.ts";

const PLAYWRIGHT_CHROME =
  "/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell --headless=old --no-sandbox --remote-debugging-pipe";
const CHROME_RENDERER =
  "/Users/x/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium --type=renderer --headless";
const USER_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NEXT_SERVER = "next-server (v16.3.4)";
const NEXT_DEV = "node /repo/node_modules/.bin/next dev -p 4899";
const ESLINT =
  "/opt/homebrew/Cellar/node/26.5.0/bin/node --import ./scripts/eslint-typescript-api.mjs ./node_modules/eslint/bin/eslint.js --no-warn-ignored";
const PLAYWRIGHT_WORKER =
  "/opt/homebrew/bin/node /Users/x/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_sh4y4rxjde-1/openbooks/node_modules/playwright/lib/worker.js";
const BB_SERVER =
  "/Applications/bb.app/Contents/MacOS/bb /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/index.js";

const kindOf = (command) => classify(command, processName(command));

test("automation browsers are recognised only by an automation flag", () => {
  assert.ok(isAutomationBrowser(PLAYWRIGHT_CHROME));
  assert.equal(isAutomationBrowser(USER_CHROME), false);
  // A renderer child rolls up into its parent rather than being killable alone.
  assert.equal(isAutomationBrowser(CHROME_RENDERER), false);
});

test("the user's own browser is never automation", () => {
  assert.equal(kindOf(USER_CHROME), "browser");
  assert.equal(kindOf("/Applications/Safari.app/Contents/MacOS/Safari"), "browser");
});

test("classification separates the four killable kinds from everything else", () => {
  assert.equal(kindOf(PLAYWRIGHT_CHROME), "browser-automation");
  assert.equal(kindOf(NEXT_SERVER), "dev-server");
  assert.equal(kindOf(NEXT_DEV), "dev-server");
  assert.equal(kindOf(ESLINT), "toolchain");
  assert.equal(kindOf(PLAYWRIGHT_WORKER), "test-runner");
});

test("BB, agents, editors and containers are all outside the killable set", () => {
  assert.equal(kindOf(BB_SERVER), "bb");
  assert.equal(kindOf("node /Users/x/.npm/_npx/abc/node_modules/@anthropic-ai/claude-code/cli.js"), "agent");
  assert.equal(kindOf("/Applications/Docker.app/Contents/MacOS/com.docker.backend"), "container");
  assert.equal(
    kindOf("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"),
    "editor",
  );
  assert.equal(kindOf("/Applications/Xcode.app/Contents/MacOS/Xcode"), "editor");
});

test("a fleet process is classified by what it is, not by living under ~/.bb", () => {
  // Regression: a BB pattern of `/\.bb/` matched every worktree path, so every
  // dev server and test runner the fleet started came back as `bb` — which is
  // outside the killable set. The plugin would have refused to reclaim
  // anything, and looked like it was working.
  assert.equal(kindOf(PLAYWRIGHT_WORKER), "test-runner");
  assert.equal(
    kindOf("node /Users/x/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_abc123de-1/app/node_modules/.bin/next dev -p 4899"),
    "dev-server",
  );
  assert.equal(kindOf(BB_SERVER), "bb");
});

test("system processes are matched on the name, not the path", () => {
  assert.equal(classify("/usr/libexec/launchd", "launchd"), "system");
  assert.equal(classify("kernel_task", "kernel_task"), "system");
  assert.equal(classify("/usr/sbin/WindowServer -daemon", "WindowServer"), "system");
  // A user binary that merely mentions a system name is not system.
  assert.equal(classify("node /repo/launchd-helper.js", "node"), "other");
});

test("an unrecognised process falls through to `other`, which is never a candidate", () => {
  assert.equal(kindOf("/usr/local/bin/some-unknown-daemon --serve"), "other");
  assert.equal(kindOf("python3 train.py"), "other");
});

test("a shell is never classified by what its arguments mention", () => {
  // Regression: `sh -c 'npx tsc'` matched the toolchain patterns and became a
  // killable `toolchain`, as did a zsh running someone's build. An interpreter
  // is `other` — the real tool is a child and is classified on its own merits.
  assert.equal(kindOf("sh -c npx tsc --noEmit"), "other");
  assert.equal(kindOf("/bin/zsh -c npm run build && eslint ."), "other");
  assert.equal(kindOf("/bin/bash /repo/scripts/run-vitest.sh"), "other");
  assert.equal(kindOf("env NODE_ENV=test next dev"), "other");
  // The tool itself, invoked directly, still classifies.
  assert.equal(kindOf("/repo/node_modules/.bin/tsc --noEmit"), "toolchain");
});

test("a long-lived tool service is never classified as a build step", () => {
  // Regression: BB's own bundler runs as `esbuild --service=...` and idles at
  // 0% CPU between requests. Classified as `toolchain` it became killable, and
  // killing it broke every subsequent plugin install until BB restarted.
  assert.equal(
    kindOf("/repo/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.0 --ping"),
    "other",
  );
  assert.equal(kindOf("node /usr/lib/node_modules/typescript/lib/tsserver.js"), "other");
  assert.equal(kindOf("/opt/homebrew/bin/watchman --foreground"), "other");
  assert.equal(kindOf("node /repo/node_modules/.bin/tsc --watch"), "other");
  assert.equal(kindOf("vscode-json-language-server --stdio"), "other");

  // A genuine one-shot build still classifies as toolchain.
  assert.equal(kindOf("/repo/node_modules/.bin/tsc --noEmit"), "toolchain");
});

test("processName survives executables with spaces in their path", () => {
  // Regression: splitting argv on whitespace turned the user's Chrome into
  // "/Applications/Google", so the row read "Google (25 processes)".
  assert.equal(processName(USER_CHROME), "Google Chrome");
  assert.equal(
    processName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer"),
    "Google Chrome",
  );
  assert.equal(processName("/Applications/bb.app/Contents/Frameworks/bb Helper (Renderer).app/Contents/MacOS/bb Helper (Renderer) --type=renderer"), "bb Helper");
});

test("ports are parsed from every flag spelling", () => {
  assert.equal(parsePort(NEXT_DEV), 4899);
  assert.equal(parsePort("next dev --port 4801"), 4801);
  assert.equal(parsePort("vite --port=5173"), 5173);
  assert.equal(parsePort(NEXT_SERVER), null);
});

test("thread ids come out of worktree paths in argv", () => {
  assert.equal(parseThreadId(PLAYWRIGHT_WORKER), "thr_sh4y4rxjde");
  assert.equal(parseThreadId(NEXT_SERVER), null);
});

test("parseEtime handles every ps duration shape", () => {
  assert.equal(parseEtime("00:48"), 48);
  assert.equal(parseEtime("12:30"), 750);
  assert.equal(parseEtime("01:02:03"), 3723);
  assert.equal(parseEtime("2-03:04:05"), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
});

test("processName prefers the executable, including app-bundle tails", () => {
  assert.equal(processName(BB_SERVER), "bb");
  assert.equal(processName("/opt/homebrew/Cellar/node/26.5.0/bin/node --test"), "node");
  assert.equal(processName("next-server (v16.3.4)"), "next-server");
});
