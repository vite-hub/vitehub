import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  bin: Record<string, string>
  exports: Record<string, string>
}

describe("single-package facade", () => {
  it("ships every declared facade and the CLI", () => {
    expect(packageJson.bin).toEqual({ vitehub: "./dist/cli.js" })

    for (const target of Object.values(packageJson.exports)) {
      if (target === "./package.json") continue
      expect(existsSync(`${packageRoot}/${target}`), target).toBe(true)
    }

    expect(readFileSync(`${packageRoot}/${packageJson.bin.vitehub}`, "utf8")).toMatch(/^#!\/usr\/bin\/env node/)
  })

  it("loads app APIs from the preset package", async () => {
    const [agent, capabilities, channels, cli, database, env, envSecret, envServer, workspace] = await Promise.all([
      import("@vite-hub/vite/agent"),
      import("@vite-hub/vite/agent/capabilities"),
      import("@vite-hub/vite/agent/channels"),
      import("@vite-hub/vite/cli"),
      import("@vite-hub/vite/database/drizzle"),
      import("@vite-hub/vite"),
      import("@vite-hub/vite/env/secret"),
      import("@vite-hub/vite/env/server"),
      import("@vite-hub/vite/workspace"),
    ])

    expect(agent.defineAgent).toBeTypeOf("function")
    expect(capabilities.access).toBeTypeOf("function")
    expect(channels.defineChannel).toBeTypeOf("function")
    expect(Object.keys(cli)).toEqual([])
    expect(database.db).toBeDefined()
    expect(env.env).toBeTypeOf("function")
    expect(envSecret.SecretEnv).toBeTypeOf("function")
    expect(envServer.resolveServerEnv).toBeTypeOf("function")
    expect(workspace.defineWorkspace).toBeTypeOf("function")
  }, 15_000)
})
