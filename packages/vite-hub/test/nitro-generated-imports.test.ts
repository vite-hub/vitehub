import { join } from "node:path"
import { expect, it, vi } from "vitest"

import { nitroGeneratedRelativeImports } from "../src/internal/nitro-generated-imports.ts"

it("resolves relative imports of generated modules to absolute files before Nitro externalizes them", async () => {
  const app = "/work/repo/playground/docs"
  const resolveId = nitroGeneratedRelativeImports([join(app, ".vitehub"), join(app, ".nuxt/vitehub")]).resolveId
  if (typeof resolveId !== "function") throw new TypeError("Expected a resolver")
  // Nitro's externals plugin answers the absolute file with an absolute URL that Node loads from any bundle folder.
  const resolveFile = vi.fn(async (id: string) => ({ id: `file://${id}`, external: true }))
  const resolve = (source: string, importer: string | undefined) => Reflect.apply(resolveId, { resolve: resolveFile }, [source, importer, { isEntry: false }])
  const runtime = join(app, ".vitehub/nitro/blob/runtime.mjs")

  expect(await resolve("../../../../../packages/blob/dist/runtime/state.js", runtime)).toEqual({ id: "file:///work/repo/packages/blob/dist/runtime/state.js", external: true })
  expect(resolveFile).toHaveBeenLastCalledWith("/work/repo/packages/blob/dist/runtime/state.js", runtime, { isEntry: false, skipSelf: true })
  expect(await resolve("./runtime.mjs", `${join(app, ".nuxt/vitehub/plugin.ts")}?query`)).toEqual({ id: `file://${join(app, ".nuxt/vitehub/runtime.mjs")}`, external: true })

  // Imports of application and package modules keep Nitro's own resolution.
  expect(await resolve("../utils/team.ts", join(app, "server/content.ts"))).toBeUndefined()
  expect(await resolve("@vite-hub/blob", runtime)).toBeUndefined()
  expect(await resolve("./runtime.mjs", undefined)).toBeUndefined()
  expect(resolveFile).toHaveBeenCalledTimes(2)
})
