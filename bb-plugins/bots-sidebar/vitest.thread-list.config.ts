import { defineConfig } from "vitest/config";

// Run upstream's tests against the same generated import overlay shipped in the
// plugin. No upstream test edits are needed when refreshing the snapshot.
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    name: "builtin-thread-list",
    include: [".generated/bb/thread-list/**/*.test.ts", ".generated/bb/thread-list/**/*.test.tsx"],
    execArgv: ["--no-experimental-webstorage"],
    maxWorkers: 1,
    testTimeout: 20_000,
    restoreMocks: true,
  },
});
