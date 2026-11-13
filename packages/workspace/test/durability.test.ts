import { expect, it } from "vitest"

import { workspaceDefinitionsDurability, workspaceDurability } from "../src/durability.ts"

import type { DurabilityContext } from "@vite-hub/runtime/durability"

const context = (env: Record<string, string | undefined> = {}): DurabilityContext => ({ env, find: () => undefined })

it("classifies the Workspace store by provider", () => {
  expect(workspaceDurability({ inferred: true, provider: "local", root: ".vitehub/workspaces" }, context())).toMatchObject([{ store: "local", scope: "host", reason: "Files in .vitehub/workspaces on this host." }])
  expect(workspaceDurability({ inferred: true, provider: "local" }, context({ BLOB_READ_WRITE_TOKEN: "token" }))).toMatchObject([{ store: "vercel-blob", scope: "shared" }])
  expect(workspaceDurability({ provider: "local" }, context({ BLOB_READ_WRITE_TOKEN: "token" }))).toMatchObject([{ store: "local", scope: "host" }])
  expect(workspaceDurability({ provider: "github" }, context())).toMatchObject([{ scope: "shared" }])
  expect(workspaceDurability({ provider: "memory" }, context())).toMatchObject([{ scope: "process" }])
  expect(workspaceDurability({ custom: true }, context())).toMatchObject([{ store: "custom", scope: "shared" }])
})

it("uses each evaluated Definition's store before the module default", () => {
  const agent = { sources: {}, __vitehubWorkspaceAgentOptions: { workspace: { store: { provider: "memory" as const } } } }
  const reports = workspaceDefinitionsDurability({
    docs: { store: { provider: "memory" } },
    files: { store: { provider: "local", root: "instance-data" } },
    shared: {},
    agent,
  }, { root: ".vitehub/workspaces", store: { provider: "github", repository: "acme/workspaces" } }, context())
  expect(reports).toMatchObject([
    { name: "docs", store: "memory", scope: "process" },
    { name: "files", store: "local", scope: "host" },
    { name: "shared", store: "github", scope: "shared" },
    { name: "agent", store: "memory", scope: "process" },
  ])
})

it("keeps an explicit-root local runtime config when Blob credentials appear at boot", () => {
  expect(workspaceDefinitionsDurability({ docs: {} }, { root: ".vitehub/workspace-data", store: { provider: "local" } }, context({ BLOB_READ_WRITE_TOKEN: "token" })))
    .toMatchObject([{ name: "docs", store: "local", scope: "host" }])
  expect(workspaceDefinitionsDurability({ docs: {} }, false, context({ BLOB_READ_WRITE_TOKEN: "token" })))
    .toMatchObject([{ name: "docs", store: "vercel-blob", scope: "shared" }])
})
