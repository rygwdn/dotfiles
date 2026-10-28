import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    fileParallelism: false,
    maxConcurrency: 1,
    silent: "passed-only",
    name: "bb-plugin-provider-omp",
    include: ["*.test.ts", "*.test.tsx", "src/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
