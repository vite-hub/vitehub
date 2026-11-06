import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { featureHosts, features, featureSupport } from "@vite-hub/internal/features"

import { usesComments } from "../../comments/src/operations-core/vite.ts"
import { normalizeWorkflowOptions } from "../../workflow/src/config.ts"
import { normalizeWorkspaceStoreOptions } from "../../workspace/src/storage/provider.ts"

describe("feature catalog parity with owner resolution", () => {
  it.each(featureHosts)("matches the default Workflow provider on %s", (host) => {
    const hosting = resolveDeploymentPlan(host === "dev" ? "node" : host).nitroPreset
    const support = featureSupport("workflow", host)
    if (support.level === "explicit") {
      expect(() => normalizeWorkflowOptions({}, { hosting })).toThrow(/workflow.provider/)
      return
    }
    expect(support.level).toBe("native")
    if (support.level === "native") expect(support.adapter).toBe(normalizeWorkflowOptions({}, { hosting })?.provider)
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

  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
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
