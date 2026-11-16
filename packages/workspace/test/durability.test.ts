import { expect, it } from "vitest"

import { workspaceDefinitionsDurability, workspaceDurability } from "../src/durability.ts"

import type { DurabilityContext } from "@vite-hub/runtime/durability"

const context = (env: Record<string, string | undefined> = {}): DurabilityContext => ({ env, find: () => undefined })

it("classifies the Workspace store by driver", () => {
  expect(workspaceDurability({ inferred: true, driver: "local", root: ".vitehub/workspaces" }, context())).toMatchObject([{ store: "local", scope: "host", reason: "Files in .vitehub/workspaces on this host." }])
  expect(workspaceDurability({ inferred: true, driver: "local" }, context({ BLOB_READ_WRITE_TOKEN: "token" }))).toMatchObject([{ store: "vercel", scope: "shared" }])
  expect(workspaceDurability({ driver: "local" }, context({ BLOB_READ_WRITE_TOKEN: "token" }))).toMatchObject([{ store: "local", scope: "host" }])
  expect(workspaceDurability({ driver: "github" }, context())).toMatchObject([{ scope: "shared" }])
  expect(workspaceDurability({ driver: "memory" }, context())).toMatchObject([{ scope: "process" }])
  expect(workspaceDurability({ custom: true }, context())).toMatchObject([{ store: "custom", scope: "shared" }])
})

it("uses each evaluated Definition's store before the module default", () => {
  const agent = { sources: {}, __vitehubWorkspaceAgentOptions: { workspace: { store: { driver: "memory" as const } } } }
  const reports = workspaceDefinitionsDurability({
    docs: { store: { driver: "memory" } },
    files: { store: { driver: "local", root: "instance-data" } },
    shared: {},
    agent,
  }, { root: ".vitehub/workspaces", store: { driver: "github", repository: "acme/workspaces" } }, context())
  expect(reports).toMatchObject([
    { name: "docs", store: "memory", scope: "process" },
    { name: "files", store: "local", scope: "host" },
    { name: "shared", store: "github", scope: "shared" },
    { name: "agent", store: "memory", scope: "process" },
  ])
})

it("keeps an explicit-root local runtime config when Blob credentials appear at boot", () => {
  expect(workspaceDefinitionsDurability({ docs: {} }, { root: ".vitehub/workspace-data", store: { driver: "local" } }, context({ BLOB_READ_WRITE_TOKEN: "token" })))
    .toMatchObject([{ name: "docs", store: "local", scope: "host" }])
  expect(workspaceDefinitionsDurability({ docs: {} }, false, context({ BLOB_READ_WRITE_TOKEN: "token" })))
    .toMatchObject([{ name: "docs", store: "vercel", scope: "shared" }])
})
