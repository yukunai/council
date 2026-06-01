import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["node_modules/**", "dist/**", "src-tauri/**", "**/*.d.ts"],
    },
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
