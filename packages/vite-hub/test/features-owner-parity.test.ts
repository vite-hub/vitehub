import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { featureHosts, features, featureSupport } from "@vite-hub/internal/features"

import { usesComments } from "../../comments/src/operations-core/vite.ts"
import { resolveDBViteConfig } from "../../database/src/config.ts"
import { supportsHostedDatabaseRuntime } from "../../database/src/internal/vite-build.ts"
import { normalizeQueueOptions } from "../../queue/src/config.ts"
import { normalizeWorkflowOptions } from "../../workflow/src/config.ts"
import { normalizeWorkspaceStoreOptions } from "../../workspace/src/storage/provider.ts"

const presets = featureHosts.filter(host => host !== "dev")

describe("feature catalog parity with owner resolution", () => {
  it.each(presets)("matches the default Workflow provider on %s", (host) => {
    const hosting = resolveDeploymentPlan(host).nitroPreset
    const support = featureSupport("workflow", host)
    if (support.level === "explicit") {
      expect(() => normalizeWorkflowOptions({}, { hosting })).toThrow(/workflow.provider/)
      return
    }
    expect(support.level).toBe("native")
    if (support.level === "native") expect(support.adapter).toBe(normalizeWorkflowOptions({}, { hosting })?.provider)
  })

  it.each(presets)("preserves the %s preset for development Workflow", (preset) => {
    const hosting = resolveDeploymentPlan(preset).nitroPreset
    const support = featureSupport("workflow", "dev", preset)
    if (support.level === "explicit") {
      expect(() => normalizeWorkflowOptions({}, { hosting })).toThrow(/workflow.provider/)
      return
    }
    expect(support.level).toBe("native")
    if (support.level === "native") expect(support.adapter).toBe(normalizeWorkflowOptions({}, { hosting })?.provider)
  })

  it.each(presets)("preserves the %s Deployment Plan for development Queue and Sandbox", (preset) => {
    const plan = resolveDeploymentPlan(preset)
    for (const [id, service] of [["queue", "queue"], ["sandboxTask", "sandbox"]] as const) {
      const support = featureSupport(id, "dev", preset)
      const policy = plan.services[service]
      if (!policy.supported) {
        expect(support.level, id).toBe("unsupported")
        continue
      }
      expect(support, id).toMatchObject({ adapter: policy.adapter, level: "native" })
      if (id === "queue" && support.level === "native") {
        expect(support.adapter).toBe(normalizeQueueOptions({ provider: policy.adapter }, { hosting: plan.nitroPreset })?.provider)
      }
    }
  })

  it.each([undefined, "", "   ", "test-token"])("matches the Vercel Workspace default with Blob token %j", (token) => {
    const env: Record<string, string | undefined> = { BLOB_READ_WRITE_TOKEN: token }
    const support = featureSupport("workspace", "vercel")
    expect(support.level).toBe("native")
    if (support.level !== "native") return
    const provider = support.envOverrides?.find(override => env[override.env]?.trim())?.support ?? support
    const store = normalizeWorkspaceStoreOptions(undefined, { env, hosting: "vercel" })
    expect(provider.adapter).toBe(store?.provider)
    expect(provider.guarantee).toBe(store?.provider === "memory" ? "process-local" : "native")
  })

  it.each(presets)("matches the local development Workspace store with the %s preset", (preset) => {
    const hosting = resolveDeploymentPlan(preset).nitroPreset
    const support = featureSupport("workspace", "dev", preset)
    expect(support).toMatchObject({ adapter: normalizeWorkspaceStoreOptions(undefined, { dev: true, hosting })?.provider, level: "native" })
  })

  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
  })

  it("requires a hosted Database connection on Vercel", () => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-feature-database-"))
    roots.push(root)
    const local = resolveDBViteConfig(undefined, root, { implicitDefault: true })!
    expect(local.databases.default?.connection?.url).toBe("file:.vitehub/data/database/sqlite.db")
    expect(supportsHostedDatabaseRuntime("vercel", local, {})).toBe(false)
    expect(featureSupport("database", "vercel")).toMatchObject({ level: "explicit", option: "database.connection" })
    const remote = resolveDBViteConfig({ connection: { url: "libsql://example.turso.io" } }, root, { implicitDefault: true })!
    expect(supportsHostedDatabaseRuntime("vercel", remote, {})).toBe(true)
  })

  it.each(["server", "custom-server"])("describes Comments discovery in %s", (directory) => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-feature-discovery-"))
    roots.push(root)
    mkdirSync(join(root, directory))
    const options = { projectRoot: root, ...(directory === "server" ? {} : { serverDirs: [directory] }) }
    expect(usesComments(options)).toBe(false)
    expect(features.comments.enabledByDefault).toBe(false)
    const files = features.comments.enabledByDiscovery
    expect(files).toEqual(["comments.ts", "comments.mts", "comments.js", "comments.mjs"])
    for (const file of files ?? []) {
      const path = join(root, directory, file)
      writeFileSync(path, "export const comments = {}")
      expect(usesComments(options), file).toBe(true)
      rmSync(path)
    }
  })
})
