import type { UserConfig } from "vite"
import { describe, expectTypeOf, it } from "vitest"

import workspaceNuxt from "../src/nuxt.ts"

import type { NitroConfig } from "../src/nitro.ts"

describe("workspace nuxt types", () => {
  it("loads Workspace Vite config types through the Nuxt entrypoint", () => {
    const config: UserConfig = {
      workspace: {
        store: {
          binding: "WORKSPACE_FILES",
          namespace: "project-workspaces",
          provider: "cloudflare-artifacts",
        },
      },
    }
    expectTypeOf(workspaceNuxt).toBeFunction()
    expectTypeOf(config.workspace).toMatchTypeOf<UserConfig["workspace"]>()
  })

  it("types Cloudflare Artifacts in generated Nitro config", () => {
    const config: NitroConfig = {
      cloudflare: {
        wrangler: {
          artifacts: [{ binding: "WORKSPACE_FILES", namespace: "project-workspaces" }],
        },
      },
    }

    expectTypeOf(config.cloudflare?.wrangler?.artifacts).toMatchTypeOf<Array<{ binding: string, namespace: string }> | undefined>()
  })
})
