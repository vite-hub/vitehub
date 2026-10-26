import { describe, expect, it } from "vitest"

import { addViteHubPageToolRoutes } from "../src/build/page-tools.ts"
import { createNitroServerKit } from "../src/nitro-kit.ts"

describe("addViteHubPageToolRoutes", () => {
  it("adds the session route and the loader asset once, for the first owner package", () => {
    const kit = createNitroServerKit({ publicAssets: [{ baseURL: "/assets", dir: "/app/public" }] })
    addViteHubPageToolRoutes(kit, { handler: "/a/page-session.mjs", loader: "/a/dist/page" })
    addViteHubPageToolRoutes(kit, { handler: "/b/page-session.mjs", loader: "/b/dist/page" })
    expect(kit.config.handlers).toEqual([{ handler: "/a/page-session.mjs", route: "/_vitehub/page/session" }])
    expect(kit.config.publicAssets).toEqual([
      { baseURL: "/assets", dir: "/app/public" },
      { baseURL: "/_vitehub/page/assets", dir: "/a/dist/page", maxAge: 300 },
    ])
  })
})
