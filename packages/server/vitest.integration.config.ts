import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server-integration",
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
