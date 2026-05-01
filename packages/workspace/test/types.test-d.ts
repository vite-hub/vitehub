import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"
import { describe, expectTypeOf, it } from "vitest"

import {
  defineWorkspace,
  loader,
  publish,
  source,
  useWorkspace,
  type Workspace,
} from "../src/index.ts"
import { hubWorkspace } from "../src/vite.ts"

describe("workspace types", () => {
  it("types public helpers", async () => {
    const definition = defineWorkspace({
      sources: [source.markdown({ path: "README.md" })],
      loaders: [loader.files()],
      publish: [publish.virtualModule({ id: "virtual:vitehub/workspaces/typed" })],
    })
    defineWorkspace({
      // @ts-expect-error workspace names are inferred from definition filenames
      name: "typed",
    })

    expectTypeOf(definition).toMatchTypeOf<object>()
    expectTypeOf(await useWorkspace("typed")).toMatchTypeOf<Workspace>()
    expectTypeOf(hubWorkspace()).toMatchTypeOf<Plugin & { nitro: NitroModule }>()
  })
})
