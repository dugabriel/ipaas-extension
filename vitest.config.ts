import { defineConfig } from "vitest/config";

// Vitest configuration: jsdom environment for DOM tests, a global chrome.* mock
// via sinon-chrome, and fast-check available for property-based tests.
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
