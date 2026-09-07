import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
