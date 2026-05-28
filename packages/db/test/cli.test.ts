import { describe, expect, it, vi } from "vitest"

import { createDbCliContributor } from "../src/cli.ts"

import type { ResolvedDBViteConfig } from "../src/types.ts"

function cliContext(spawn: ReturnType<typeof vi.fn>) {
  return {
    rootDir: "/repo",
    spawn,
    stderr: { write: vi.fn() },
    stdout: { write: vi.fn() },
  } as never
}

describe("DB CLI contributor", () => {
  it("runs Drizzle Kit once per named database config", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const config = {
      databaseNames: ["analytics", "primary"],
      generatedDrizzleConfigFile: "/repo/.vitehub/db/drizzle.config.ts",
      generatedDrizzleConfigFilesByDatabase: {
        analytics: "/repo/.vitehub/db/drizzle/analytics.config.ts",
        primary: "/repo/.vitehub/db/drizzle/primary.config.ts",
      },
    } as unknown as ResolvedDBViteConfig
    const contributor = createDbCliContributor(undefined, () => config)!
    const generate = contributor.namespaces[0]!.features.find(feature => feature.name === "generate")!

    await expect(generate.run(["--name", "init"], cliContext(spawn))).resolves.toBe(0)

    expect(spawn).toHaveBeenNthCalledWith(1, "pnpm", [
      "exec",
      "drizzle-kit",
      "generate",
      "--config",
      ".vitehub/db/drizzle/analytics.config.ts",
      "--name",
      "init",
    ], expect.objectContaining({ cwd: "/repo" }))
    expect(spawn).toHaveBeenNthCalledWith(2, "pnpm", [
      "exec",
      "drizzle-kit",
      "generate",
      "--config",
      ".vitehub/db/drizzle/primary.config.ts",
      "--name",
      "init",
    ], expect.objectContaining({ cwd: "/repo" }))
  })

  it("keeps the aggregate Drizzle config for a single database", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const config = {
      databaseNames: ["default"],
      generatedDrizzleConfigFile: "/repo/.vitehub/db/drizzle.config.ts",
      generatedDrizzleConfigFilesByDatabase: {
        default: "/repo/.vitehub/db/drizzle/default.config.ts",
      },
    } as unknown as ResolvedDBViteConfig
    const contributor = createDbCliContributor(undefined, () => config)!
    const migrate = contributor.namespaces[0]!.features.find(feature => feature.name === "migrate")!

    await expect(migrate.run([], cliContext(spawn))).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith("pnpm", [
      "exec",
      "drizzle-kit",
      "migrate",
      "--config",
      ".vitehub/db/drizzle.config.ts",
    ], expect.objectContaining({ cwd: "/repo" }))
  })
})
