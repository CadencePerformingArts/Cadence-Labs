// Two test runners share this repo and must not eat each other's files:
// vitest owns the monorepo packages (packages/**, apps/**), while
// tests/unit/** are node:test suites run by `node --test` in CI — vitest
// sees no describe/it in them and fails the whole run with
// "No test suite found".
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/**"],
  },
});
