import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { resolveSandboxProject } from "../src/project.ts"
import { bundleSandboxDefinition } from "../src/bundle.ts"
import { executeSandboxDefinition } from "../src/runtime/execute.ts"
import { createSandboxExecutionBox } from "../src/runtime/execution-box.ts"
import { resolveBox, trustedHost } from "@vite-hub/box"

const roots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-project-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("resolveSandboxProject", () => {
  it("reads timeout from package metadata for executable entries", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      vitehub: { sandbox: { timeout: 60_000 } },
    }))
    await writeFile(entry, "export default null")

    const project = await resolveSandboxProject(entry, root, { readSandboxOptions: true })

    expect(project.options).toEqual({ timeout: 60_000 })
  })

  it("rejects package imports that Node cannot resolve directly", async () => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "helper.ts"), "export const ok = true\n")
    await writeFile(entry, "import { ok } from './helper'\nexport default { ok }\n")

    const project = await resolveSandboxProject(entry, root)

    await expect(bundleSandboxDefinition(await readFile(entry, "utf8"), entry, {
      execution: "module",
      project,
    })).rejects.toThrow('imports "./helper", which is not an executable package file')
  })

  it.each([
    [{ timeout: 0 }, "positive integer"],
    [{ timeout: 1.5 }, "positive integer"],
    [{ timeout: 2_147_483_648 }, "positive integer"],
    [{ env: { MODE: "test" } }, "unsupported keys: env"],
  ])("rejects invalid package Sandbox metadata", async (sandboxOptions, message) => {
    const root = await createRoot()
    const entry = join(root, "index.ts")
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      vitehub: { sandbox: sandboxOptions },
    }))
    await writeFile(entry, "export default null")

    await expect(resolveSandboxProject(entry, root, { readSandboxOptions: true }))
      .rejects.toThrow(message)
  })

  it("resolves independent nearest package roots", async () => {
    const root = await createRoot()
    const first = join(root, "sandboxes/first")
    const second = join(root, "sandboxes/second")
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(second, "package.json"), JSON.stringify({ packageManager: "npm@11", private: true, type: "module" }))
    await writeFile(join(first, "run.sandbox.ts"), "export default null")
    await writeFile(join(second, "run.sandbox.ts"), "export default null")

    const firstProject = await resolveSandboxProject(join(first, "run.sandbox.ts"), root)
    const secondProject = await resolveSandboxProject(join(second, "run.sandbox.ts"), root)

    expect(firstProject.install.command).toBe("npm")
    expect(secondProject.install.command).toBe("npm")
    expect(firstProject.digest).not.toBe(secondProject.digest)
  })

  it("delegates pnpm installation to the standard workspace root", async () => {
    const root = await createRoot()
    const packageRoot = join(root, "sandboxes/image")
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10", private: true }))
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - sandboxes/*\n")
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    await writeFile(join(root, "sandboxes/pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters: {}\n")
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(packageRoot, "optimize.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(packageRoot, "optimize.sandbox.ts"), root)

    expect(project.install).toEqual({
      args: ["install", "--frozen-lockfile"],
      command: "pnpm",
      cwd: ".",
    })
    expect(project.packagePath).toBe("sandboxes/image")
    expect(project.files).toHaveProperty("pnpm-workspace.yaml")
    expect(project.files).toHaveProperty("pnpm-lock.yaml")
    expect(project.files).not.toHaveProperty("sandboxes/pnpm-lock.yaml")
    expect(project.files).toHaveProperty("sandboxes/image/package.json")
  })

  it("includes the transitive local pnpm workspace dependency closure", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const first = join(root, "packages/first")
    const second = join(root, "packages/second")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(first, { recursive: true }), mkdir(second, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['sandboxes/*', 'packages/*']\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ dependencies: { "@fixture/first": "workspace:*" }, private: true }))
    await writeFile(join(first, "package.json"), JSON.stringify({ dependencies: { "@fixture/second": "workspace:^" }, name: "@fixture/first", type: "module" }))
    await writeFile(join(first, "index.js"), "export { value } from '@fixture/second'\n")
    await writeFile(join(second, "package.json"), JSON.stringify({ exports: "./index.js", name: "@fixture/second", type: "module" }))
    await writeFile(join(second, "index.js"), "export const value = 42\n")
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root)

    expect(project.install.command).toBe("pnpm")
    expect(project.files).toHaveProperty("packages/first/index.js")
    expect(project.files).toHaveProperty("packages/second/index.js")
  })

  it("installs and executes a transitive workspace dependency", { timeout: 30_000 }, async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/image")
    const first = join(root, "packages/first")
    const second = join(root, "packages/second")
    await Promise.all([mkdir(sandbox, { recursive: true }), mkdir(first, { recursive: true }), mkdir(second, { recursive: true })])
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - sandboxes/*\n  - packages/*\n")
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ dependencies: { "@fixture/first": "workspace:*" }, private: true }))
    await mkdir(join(sandbox, "lib"))
    await writeFile(join(sandbox, "lib/prompt.md"), "relative helper asset")
    await writeFile(join(sandbox, "lib/helper.ts"), [
      "import { readFile } from 'node:fs/promises'",
      "export const asset = await readFile(new URL('./prompt.md', import.meta.url), 'utf8')",
      "",
    ].join("\n"))
    await writeFile(join(sandbox, "lib/helper.d.ts"), "export { Missing } from './missing'\n")
    await writeFile(join(first, "package.json"), JSON.stringify({ dependencies: { "@fixture/second": "workspace:*" }, exports: "./index.js", name: "@fixture/first", type: "module" }))
    await writeFile(join(first, "index.js"), "export { value } from '@fixture/second'\n")
    await writeFile(join(second, "package.json"), JSON.stringify({ exports: "./index.js", name: "@fixture/second", type: "module" }))
    await writeFile(join(second, "index.js"), "export const value = 42\n")
    const definitionFile = join(sandbox, "index.ts")
    await writeFile(definitionFile, [
      "import { readFile } from 'node:fs/promises'",
      "import { value } from '@fixture/first'",
      "import { asset } from './lib/helper.ts'",
      "const { payload, context } = JSON.parse(await readFile(process.argv[2], 'utf8'))",
      "await Promise.resolve()",
      "export default { asset, context, payload, value }",
      "",
    ].join("\n"))

    const project = await resolveSandboxProject(definitionFile, root)
    expect(project.files).toHaveProperty("sandboxes/image/lib/prompt.md")
    const bundle = await bundleSandboxDefinition(await readFile(definitionFile, "utf8"), definitionFile, {
      execution: "module",
      project,
    })
    const box = await resolveBox({ runtime: trustedHost() }, {}, { requires: ["node", "pnpm"] })
    const session = await box.open()
    try {
      const execution = createSandboxExecutionBox(session, "vercel")
      const root = dirname(session.cwd)
      const physical = (path: string) => path.startsWith('/') ? join(root, path) : path
      const exec = execution.exec
      const writeFile = execution.writeFile
      execution.exec = async (command, args = [], options) => await exec(command, args.map(physical), {
        ...options,
        cwd: options?.cwd && physical(options.cwd),
      })
      execution.writeFile = async (path, contents) => await writeFile(path, contents.replaceAll('/tmp/vitehub-sandbox', `${root}/tmp/vitehub-sandbox`))
      await expect(executeSandboxDefinition(
        execution,
        "workspace-dependency",
        undefined,
        bundle,
        { requested: true },
        { requestId: "test" },
      )).resolves.toEqual({
        asset: "relative helper asset",
        context: { requestId: "test" },
        payload: { requested: true },
        value: 42,
      })
    }
    finally {
      await session.close()
    }
  })

  it("does not inherit an unrelated ancestor lockfile", async () => {
    const root = await createRoot()
    const sandbox = join(root, "sandboxes/independent")
    await mkdir(sandbox, { recursive: true })
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, name: "root" }))
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(sandbox, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root)

    expect(project.install).toEqual({ args: ["install"], command: "npm", cwd: "." })
    expect(project.packagePath).toBe(".")
    expect(project.files).not.toHaveProperty("package-lock.json")
  })

  it("ignores legacy binary bun.lockb files", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "bun.lockb"), new Uint8Array([0, 255, 1]))
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.install.command).toBe("npm")
    expect(project.files).not.toHaveProperty("bun.lockb")
  })

  it("does not upload local environment and npm credential files", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, ".env"), "TOKEN=secret\n")
    await writeFile(join(root, ".env.local"), "TOKEN=local-secret\n")
    await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n")
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/.env.production"), "TOKEN=nested-secret\n")
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.files).not.toHaveProperty(".env")
    expect(project.files).not.toHaveProperty(".env.local")
    expect(project.files).not.toHaveProperty(".npmrc")
    expect(project.files).not.toHaveProperty("src/.env.production")
  })

  it("preserves executable project file modes", async () => {
    const root = await createRoot()
    await mkdir(join(root, "scripts"))
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "scripts/build.sh"), "#!/bin/sh\n")
    await chmod(join(root, "scripts/build.sh"), 0o755)
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.files["scripts/build.sh"]?.mode).toBe(0o755)
    expect(project.files["package.json"]?.mode).toBeUndefined()
  })

  it("uses the Yarn Classic frozen lockfile flag", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.22", private: true }))
    await writeFile(join(root, "yarn.lock"), "# yarn lockfile v1\n")
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.install).toEqual({ args: ["install", "--frozen-lockfile"], command: "yarn", cwd: "." })
  })

  it("recognizes Yarn Classic from a lockfile without a packageManager field", async () => {
    const root = await createRoot()
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "yarn.lock"), "# yarn lockfile v1\n")
    await writeFile(join(root, "run.sandbox.ts"), "export default null")

    const project = await resolveSandboxProject(join(root, "run.sandbox.ts"), root)

    expect(project.install).toEqual({ args: ["install", "--frozen-lockfile"], command: "yarn", cwd: "." })
  })

  it("does not escape the Sandbox scan root for a manifest", async () => {
    const parent = await createRoot()
    const root = join(parent, "app")
    const sandbox = join(root, "sandboxes/task")
    await mkdir(sandbox, { recursive: true })
    await writeFile(join(parent, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    await expect(resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root))
      .rejects.toThrow("requires a package.json")
  })

  it("rejects project files that escape the scan root through symlinks", async () => {
    const parent = await createRoot()
    const root = join(parent, "app")
    const sandbox = join(root, "sandboxes/task")
    const externalManifest = join(parent, "package.json")
    await mkdir(sandbox, { recursive: true })
    await writeFile(externalManifest, JSON.stringify({ private: true }))
    await symlink(externalManifest, join(sandbox, "package.json"))
    await writeFile(join(sandbox, "run.sandbox.ts"), "export default null")

    await expect(resolveSandboxProject(join(sandbox, "run.sandbox.ts"), root))
      .rejects.toThrow("escapes its scan root")
  })
})
