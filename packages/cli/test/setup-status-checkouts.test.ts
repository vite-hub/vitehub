import { describe, expect, it } from "vitest"

import { createProject, isolateProjectPackages, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

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
      "vite.config.ts": viteConfig('{ host: "deno", workspace: true }'),
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

    const offline = await runSetup(["status", "--offline"], root)
    const offlineJson = await runSetup<{ checkouts: unknown }>(["status", "--offline", "--json"], root)
    expect(offline.exitCode).toBe(0)
    expect(offline.stdout).toMatch(/^live +not checked \(--offline\)$/mu)
    expect(offline.stdout).toContain("\nCheckouts (vitehub.lock):\nsite: content/ has 1 conflict\n")
    expect(offlineJson.exitCode).toBe(0)
    expect(offlineJson.json).toMatchObject({ checkouts: [{ root, workspace: "site" }], live: null, liveReason: "offline" })
  })

  it("says so when no installed package can read the lock file, and adds nothing without one", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{}"), "vitehub.lock": lock })
    isolateProjectPackages(root)
    expect((await runSetup(["status"], root)).stdout).toContain("vitehub.lock lists checkout folders, but the project does not install vite-hub or @vite-hub/workspace")
    expect((await runSetup<{ checkouts: unknown }>(["status", "--json"], root)).json.checkouts).toEqual({ error: expect.stringContaining("does not install") })

    const plain = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{}") })
    isolateProjectPackages(plain)
    expect((await runSetup(["status"], plain)).stdout).not.toContain("Checkouts")
    expect((await runSetup<Record<string, unknown>>(["status", "--json"], plain)).json).not.toHaveProperty("checkouts")
  })
})
