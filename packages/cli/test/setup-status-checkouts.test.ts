import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

const lock = JSON.stringify({ version: 1, workspaces: { site: { dir: "content", files: {}, head: "r1", ref: "draft" } } })

/** A stand-in for `@vite-hub/workspace/checkout`, installed in the project. */
const workspacePackage = {
  "node_modules/@vite-hub/workspace/package.json": JSON.stringify({ name: "@vite-hub/workspace", type: "module", exports: { "./checkout": "./checkout.js" } }),
  "node_modules/@vite-hub/workspace/checkout.js": [
    "export async function localCheckoutStatus(root) { return [{ workspace: 'site', root }] }",
    "export function formatWorkspaceStatus(status) { return `${status.workspace}: content/ has 1 conflict\\n` }",
  ].join("\n"),
}

describe("vitehub status with vitehub.lock", () => {
  it("shows the host link and the checkout folders that the Workspace package reads", async () => {
    const command = "pnpm dlx vite-hub init . --host deno --features workspace --yes"
    const root = await createProject({
      "package.json": pnpmManifest,
      "README.md": `<!-- vitehub:stack -->\n${command}\n<!-- /vitehub:stack -->\n`,
      "vite.config.ts": viteConfig('{ preset: "deno", workspace: true }'),
      "vitehub.lock": lock,
      ...workspacePackage,
    })
    expect((await runSetup(["link", "--json"], root)).exitCode).toBe(0)

    const text = await runSetup(["status"], root)
    const json = await runSetup<{ checkouts: unknown }>(["status", "--json"], root)

    expect(text.exitCode).toBe(0)
    expect(text.stdout).toContain("app on deno")
    expect(text.stdout).toContain(command)
    expect(text.stdout).toContain("\nCheckouts (vitehub.lock):\nsite: content/ has 1 conflict\n")
    expect(json.json).toMatchObject({ link: { host: "deno", project: { name: "app" }, verified: false }, stack: { command } })
    expect(json.json.checkouts).toEqual([{ root, workspace: "site" }])
    expect(text.loadConfig).not.toHaveBeenCalled()
  })

  it("says so when no installed package can read the lock file, and adds nothing without one", async () => {
    // pnpm's test shim exposes workspace packages through NODE_PATH. Start a fresh
    // resolver so these empty projects cannot borrow the workspace's packages.
    const status = async (cwd: string, json = false) => (await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../src/index.ts", import.meta.url)), "status", ...(json ? ["--json"] : []),
    ], { cwd, env: { ...process.env, NODE_PATH: "" } })).stdout

    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{}"), "vitehub.lock": lock })
    expect(await status(root)).toContain("vitehub.lock lists checkout folders, but the project does not install vite-hub or @vite-hub/workspace")
    expect(JSON.parse(await status(root, true))).toMatchObject({ checkouts: { error: expect.stringContaining("does not install") } })

    const plain = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{}") })
    expect(await status(plain)).not.toContain("Checkouts")
    expect(JSON.parse(await status(plain, true))).not.toHaveProperty("checkouts")
  })
})
