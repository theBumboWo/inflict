import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "test/unit/**/*.test.ts",
      "test/property/**/*.test.ts",
      "test/integration/**/*.test.ts"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/renderer/**/*.tsx", "src/renderer/**/*.ts"]
    }
  }
});
