import { afterEach, describe, expect, it } from "vitest"

import { resetWorkspaceAssetsRegistry, setWorkspaceAssetsRegistry, useWorkspaceAssets } from "../src/asset-registry.ts"
import { createWorkspaceAssets } from "../src/runtime/assets.ts"

afterEach(() => resetWorkspaceAssetsRegistry())

describe("workspace assets registry", () => {
  it("does not resolve inherited asset names", () => {
    setWorkspaceAssetsRegistry({ docs: createWorkspaceAssets({}) })

    expect(() => useWorkspaceAssets("toString" as never)).toThrow()
  })
})
