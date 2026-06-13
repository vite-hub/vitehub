import type { UserConfig } from "vite"
import { describe, expectTypeOf, it } from "vitest"

import workspaceNuxt from "../src/nuxt.ts"

describe("workspace nuxt types", () => {
  it("loads Workspace Vite config types through the Nuxt entrypoint", () => {
    const config: UserConfig = {
      workspace: {
        store: { provider: "memory" },
      },
    }

    expectTypeOf(workspaceNuxt).toBeFunction()
    expectTypeOf(config.workspace).toMatchTypeOf<UserConfig["workspace"]>()
  })
})
