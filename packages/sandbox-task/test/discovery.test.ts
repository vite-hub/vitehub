import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { discoverSandboxTaskDefinitions, discoverServerSandboxTaskDefinitions } from "../src/discovery.ts"
import { resolveSandboxTaskProject } from "../src/project.ts"

const tempDirs: string[] = []

async function createTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("discoverServerSandboxTaskDefinitions", () => {
  it("discovers sandbox names for Vite suffix and server entrypoints", async () => {
    const rootDir = await createTempDir("vitehub-sandbox-task-vite-discovery-")
    await mkdir(join(rootDir, "src", "content"), { recursive: true })
    await mkdir(join(rootDir, "server", "sandbox-tasks", "billing"), { recursive: true })
    await writeFile(join(rootDir, "src", "release-notes.sandbox-task.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "src", "content", "summary.sandbox-task.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "sandbox-tasks", "billing", "package.json"), JSON.stringify({ private: true }), "utf8")
    await writeFile(join(rootDir, "server", "sandbox-tasks", "billing", "index.ts"), "export default null\n", "utf8")

    expect(discoverSandboxTaskDefinitions({ rootDir }).map(definition => ({
      name: definition.name,
      kind: definition.kind,
      source: definition.source,
    }))).toEqual([
      { kind: "package-entry", name: "billing", source: "server-sandbox-tasks" },
      { kind: "definition", name: "content/summary", source: "vite-suffix" },
      { kind: "definition", name: "release-notes", source: "vite-suffix" },
    ])
  })

  it("does not discover free-form files inside server/sandbox-tasks", async () => {
    const rootDir = await createTempDir("vitehub-sandbox-task-vite-server-suffix-")
    await mkdir(join(rootDir, "server", "sandbox-tasks"), { recursive: true })
    await mkdir(join(rootDir, "src", "server", "sandbox-tasks"), { recursive: true })
    await writeFile(join(rootDir, "server", "sandbox-tasks", "release-notes.sandbox-task.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "src", "server", "sandbox-tasks", "ignored.sandbox-task.ts"), "export default null\n", "utf8")

    expect(discoverSandboxTaskDefinitions({ rootDir })).toEqual([])
  })

  it("discovers package entrypoints without registering package helpers", async () => {
    const scanDir = await createTempDir("vitehub-sandbox-task-server-discovery-")
    await mkdir(join(scanDir, "sandbox-tasks", "content", "summary"), { recursive: true })
    await mkdir(join(scanDir, "sandbox-tasks", "billing"), { recursive: true })
    await writeFile(join(scanDir, "sandbox-tasks", "content", "package.json"), JSON.stringify({ private: true }), "utf8")
    await writeFile(join(scanDir, "sandbox-tasks", "content", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "sandbox-tasks", "content", "summary.ts"), "export const summary = true\n", "utf8")
    await writeFile(join(scanDir, "sandbox-tasks", "billing", "package.json"), JSON.stringify({ private: true }), "utf8")
    await writeFile(join(scanDir, "sandbox-tasks", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "sandbox-tasks", "ignored.ts"), "export default null\n", "utf8")

    expect(discoverServerSandboxTaskDefinitions([scanDir]).map(definition => definition.name)).toEqual([
      "billing",
      "content",
    ])
  })

  it("treats workspace roots and nested packages as project internals", async () => {
    const scanDir = await createTempDir("vitehub-sandbox-task-server-workspace-")
    const workspaceRoot = join(scanDir, "sandbox-tasks")
    const sandboxTaskRoot = join(workspaceRoot, "image")
    const helperRoot = join(sandboxTaskRoot, "packages", "helper")
    await mkdir(helperRoot, { recursive: true })
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ packageManager: "pnpm@10", private: true }), "utf8")
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - image\n  - image/packages/*\n", "utf8")
    await writeFile(join(workspaceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
    await writeFile(join(sandboxTaskRoot, "package.json"), JSON.stringify({
      dependencies: { "@fixture/helper": "workspace:*" },
      private: true,
    }), "utf8")
    await writeFile(join(sandboxTaskRoot, "index.ts"), "export default { ok: true }\n", "utf8")
    await writeFile(join(helperRoot, "package.json"), JSON.stringify({ name: "@fixture/helper", private: true }), "utf8")
    await writeFile(join(helperRoot, "index.ts"), "export const helper = true\n", "utf8")

    const definitions = discoverServerSandboxTaskDefinitions([scanDir])
    expect(definitions.map(definition => definition.name)).toEqual(["image"])

    const project = await resolveSandboxTaskProject(definitions[0]!.handler, scanDir)
    expect(project.install).toMatchObject({ command: "pnpm", cwd: "." })
    expect(project.packagePath).toBe("image")
    expect(project.files).toHaveProperty("image/packages/helper/package.json")
    expect(project.files).toHaveProperty("image/packages/helper/index.ts")
  })

  it("rejects manifest-declared packages without one ESM entrypoint", async () => {
    const scanDir = await createTempDir("vitehub-sandbox-task-server-shape-")
    const packageRoot = join(scanDir, "sandbox-tasks", "content")
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ private: true }), "utf8")

    expect(() => discoverServerSandboxTaskDefinitions([scanDir])).toThrow("requires one ESM entrypoint")

    await writeFile(join(packageRoot, "index.ts"), "export default null\n", "utf8")
    await writeFile(join(packageRoot, "index.mjs"), "export default null\n", "utf8")

    expect(() => discoverServerSandboxTaskDefinitions([scanDir])).toThrow("has multiple entrypoints")
  })

  it("uses a nested package folder for the Definition name and project root", async () => {
    const rootDir = await createTempDir("vitehub-sandbox-task-package-discovery-")
    const packageDir = join(rootDir, "server", "sandbox-tasks", "tools", "image-optimizer")
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(rootDir, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.22", private: true }), "utf8")
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ packageManager: "npm@11", private: true }), "utf8")
    await writeFile(join(packageDir, "index.ts"), "export default null\n", "utf8")

    const definitions = discoverSandboxTaskDefinitions({ rootDir })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.name).toBe("tools/image-optimizer")

    const project = await resolveSandboxTaskProject(definitions[0]!.handler, rootDir)
    expect(project.packagePath).toBe(".")
    expect(project.install.command).toBe("npm")
  })

  it("rejects duplicate sandbox names across server scan dirs", async () => {
    const firstScanDir = await createTempDir("vitehub-sandbox-task-server-first-")
    const secondScanDir = await createTempDir("vitehub-sandbox-task-server-second-")
    await mkdir(join(firstScanDir, "sandbox-tasks", "release-notes"), { recursive: true })
    await mkdir(join(secondScanDir, "sandbox-tasks", "release-notes"), { recursive: true })
    await writeFile(join(firstScanDir, "sandbox-tasks", "release-notes", "package.json"), JSON.stringify({ private: true }), "utf8")
    await writeFile(join(secondScanDir, "sandbox-tasks", "release-notes", "package.json"), JSON.stringify({ private: true }), "utf8")
    await writeFile(join(firstScanDir, "sandbox-tasks", "release-notes", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(secondScanDir, "sandbox-tasks", "release-notes", "index.ts"), "export default null\n", "utf8")

    expect(() => discoverServerSandboxTaskDefinitions([firstScanDir, secondScanDir])).toThrow(/Duplicate Sandbox Task name/)
  })

  it("creates a runtime registry file", async () => {
    const rootDir = await createTempDir("vitehub-sandbox-task-registry-")
    const registryFile = join(rootDir, ".vitehub", "sandbox-task", "registry.mjs")
    const sourceFile = join(rootDir, "definition.mjs")
    await writeFile(sourceFile, "export default null\n", "utf8")

    expect(createRuntimeRegistryContents(registryFile, [{
      handler: sourceFile,
      name: "release-notes",
    }])).toContain('["release-notes"]: async () => import(')
  })
})
