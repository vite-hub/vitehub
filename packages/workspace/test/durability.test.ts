import { expect, it } from "vitest"

import { workspaceDurability } from "../src/durability.ts"

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
