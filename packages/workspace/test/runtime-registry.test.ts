import { expect, it } from "vitest"

import {
  registerWorkspace,
  resolveRegisteredWorkspaceDefinition,
  setWorkspaceRuntimeDefinitions,
  setWorkspaceRuntimeRegistry,
} from "../src/runtime.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"

it("replaces a catalog's definitions while retaining application and other catalog registrations", async () => {
  const scope = crypto.randomUUID()
  const otherScope = crypto.randomUUID()
  const directName = crypto.randomUUID()
  const direct = registerWorkspace(directName, { rootDir: "/application/direct" })
  try {
    setWorkspaceRuntimeRegistry({ content: async () => ({ default: { rootDir: "/application/content" } }) })
    const content = await resolveRegisteredWorkspaceDefinition("content")
    setWorkspaceRuntimeDefinitions(otherScope, { docs: { rootDir: "/other/docs" } })
    setWorkspaceRuntimeDefinitions(scope, { content: { rootDir: "/agent/content" }, [directName]: {} })
    expect((await resolveRegisteredWorkspaceDefinition("content")).rootDir).toBe("/agent/content")
    expect(await resolveRegisteredWorkspaceDefinition(directName)).toBe(direct)

    setWorkspaceRuntimeDefinitions(scope, { renamed: { rootDir: "/agent/renamed" } })
    expect(await resolveRegisteredWorkspaceDefinition("content")).toBe(content)
    expect((await resolveRegisteredWorkspaceDefinition("renamed")).rootDir).toBe("/agent/renamed")

    setWorkspaceRuntimeDefinitions(scope, {})
    await expect(resolveRegisteredWorkspaceDefinition("renamed")).rejects.toThrow("not registered")
    expect((await resolveRegisteredWorkspaceDefinition("docs")).rootDir).toBe("/other/docs")
    expect(await resolveRegisteredWorkspaceDefinition("content")).toBe(content)
    expect(await resolveRegisteredWorkspaceDefinition(directName)).toBe(direct)
  }
  finally {
    setWorkspaceRuntimeDefinitions(scope, {})
    setWorkspaceRuntimeDefinitions(otherScope, {})
    resetWorkspaceRegistry()
  }
})

it("reads a registry that the startup plugin set through the light registry module", async () => {
  const light = await import("../src/runtime/registry.ts")
  try {
    light.setWorkspaceRuntimeRegistry({ startup: async () => ({ default: { rootDir: "/application/startup" } }) })
    expect((await resolveRegisteredWorkspaceDefinition("startup")).rootDir).toBe("/application/startup")

    // A new registry drops what the core loaded from the old one.
    light.setWorkspaceRuntimeRegistry({ startup: async () => ({ default: { rootDir: "/application/replaced" } }) })
    expect((await resolveRegisteredWorkspaceDefinition("startup")).rootDir).toBe("/application/replaced")
  }
  finally {
    resetWorkspaceRegistry()
  }
})
