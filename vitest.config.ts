import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// DB integration tests need DATABASE_URL and write to the one (shared, production) database,
// so they are opt-in: `pnpm test:db`. Plain `pnpm test` and CI never load it, so they skip.
if (process.env.DB_TESTS === "1" && existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
