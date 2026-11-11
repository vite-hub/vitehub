import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  out: "./server/databases/migrations",
  schema: "./server/databases/config.ts",
})
