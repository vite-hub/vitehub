import { expect, it } from "vitest"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { createBlobDatabaseWorkspaceStore } from "../src/blob-database.ts"
import { workspaceDefinitionsDurability, workspaceDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"
import type { BlobStorage } from "@vite-hub/blob"

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
  }, { root: ".vitehub/workspaces", store: { driver: "github", repo: "acme/workspaces" } }, context())
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

it("reports a Blob + Database Store as shared only when its Blob store and its Database are both shared", () => {
  const reports: Durability[] = [
    { primitive: "blob", name: "default", store: "s3", scope: "shared", reason: "An S3 bucket." },
    { primitive: "blob", name: "disk", store: "fs", scope: "host", reason: "Files on this host.", fix: "Use a shared Blob store." },
    { primitive: "database", name: "history", store: "postgresql", scope: "shared", reason: "A Postgres server." },
    { primitive: "database", name: "local", store: "sqlite", scope: "host", reason: "A SQLite file on this host.", fix: "Use a shared Database." },
  ]
  const shared: DurabilityContext = {
    env: {},
    find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && report.name === name),
  }
  const store = (blob: string | BlobStorage, database: string) => ({ store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: "docs" }) })

  expect(workspaceDefinitionsDurability({ docs: store("default", "history") }, false, shared)).toMatchObject([
    { name: "docs", store: "blob-database (s3, postgresql)", scope: "shared" },
  ])
  expect(workspaceDefinitionsDurability({ docs: store("disk", "history") }, false, shared)).toMatchObject([
    { name: "docs", scope: "host", fix: "Use a shared Blob store." },
  ])
  expect(workspaceDefinitionsDurability({ docs: store("default", "local") }, false, shared)).toMatchObject([
    { name: "docs", scope: "host", fix: "Use a shared Database." },
  ])
  expect(workspaceDefinitionsDurability({ docs: store("default", "missing") }, false, shared)).toMatchObject([
    { name: "docs", scope: "process", reason: expect.stringContaining("the missing Database, which is off") },
  ])
  expect(workspaceDefinitionsDurability({ docs: store(createBlobStorage(createDriver({ driver: "fs", base: ".vitehub/unused" })), "history") }, false, shared)).toMatchObject([
    { name: "docs", store: "blob-database", scope: "shared", reason: expect.stringContaining("pass their names") },
  ])
})
