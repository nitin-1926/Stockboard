import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read env files; CI/Vercel provide the vars directly.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  // Migrations need a direct (unpooled) connection.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED! },
});
