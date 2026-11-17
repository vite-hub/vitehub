import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createProject, runSetup } from "./setup-helpers.ts"

import type { SetupUpdatePlan } from "../src/setup/index.ts"

const sha = "01898b8161a1b2c3d4e5f60718293a4b5c6d7e8f"
const preview = (name: string) => `https://pkg.pr.new/vite-hub/vitehub/${name}@${sha}`

/** npm answers `latest` for `published`, pkg.pr.new has the build of `published`, and both answer 404 for the rest. */
function registry(published: Record<string, string>) {
  const requests: string[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(`${init?.method ?? "GET"} ${url}`)
    const npm = /^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/u.exec(url)
    const name = npm ? decodeURIComponent(npm[1]!) : url.match(/^https:\/\/pkg\.pr\.new\/vite-hub\/vitehub\/(.+)@[0-9a-f]+$/u)?.[1]
    if (!name || !(name in published)) return new Response("Not found", { status: 404 })
    return npm ? Response.json({ name, version: published[name] }) : new Response(null, { status: 200 })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

/** A pnpm workspace shaped like the apps that pin ViteHub by hand: an override block, a catalog, and release-age entries. */
const workspaceYaml = `packages:
  - site
  - cli

catalog:
  vite-hub: ^0.0.4
  vue: ^3.5.0

overrides:
  # vitehub:start
  "vite-hub": https://pkg.pr.new/vite-hub/vitehub/vite-hub@caff6eb
  "@vite-hub/env": https://pkg.pr.new/vite-hub/vitehub/@vite-hub/env@caff6eb
  "@vite-hub/kit": https://pkg.pr.new/vite-hub/vitehub/@vite-hub/kit@caff6eb
  # vitehub:end
  # Keep one h3.
  h3: 2.0.8

minimumReleaseAgeExclude:
  - 'comark@0.9.0'
  - 'vite-hub@0.0.4'
  - '@vite-hub/env@0.0.4 || 0.1.0'
  - nostics@1.4.0
`

async function pnpmWorkspace() {
  return await createProject({
    "cli/package.json": `${JSON.stringify({ devDependencies: { "@vite-hub/cli": "0.0.4" }, name: "cli" }, null, 2)}\n`,
    "package.json": `${JSON.stringify({ name: "evals", packageManager: "pnpm@11.18.0", private: true }, null, 2)}\n`,
    "pnpm-workspace.yaml": workspaceYaml,
    "site/package.json": `${JSON.stringify({ dependencies: { "@vite-hub/agent": "^0.0.4", "nuxt": "^5.0.0", "vite-hub": "catalog:" }, name: "site" }, null, 2)}\n`,
  })
}

const released = { "@vite-hub/agent": "0.1.0", "@vite-hub/cli": "0.1.0", "@vite-hub/env": "0.1.0", "vite-hub": "0.1.0" }

describe("vitehub update", () => {
  it("moves every ViteHub dependency, catalog entry, and override of a pnpm workspace to the npm release", async () => {
    const root = await pnpmWorkspace()
    const { fetch } = registry(released)
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const result = await runSetup<SetupUpdatePlan>(["update", "--json"], root, {}, { fetch, spawn })

    expect(result.exitCode, result.stderr + result.stdout).toBe(0)
    expect(result.json).toMatchObject({
      install: { command: "pnpm update --recursive vite-hub \"@vite-hub/*\"" },
      packages: { "@vite-hub/agent": "^0.1.0", "@vite-hub/cli": "0.1.0", "@vite-hub/env": "0.1.0", "vite-hub": "^0.1.0" },
      status: "applied",
      target: { version: "0.1.0" },
    })
    expect(result.json.changes.map(change => change.path)).toEqual(["cli/package.json", "site/package.json", "pnpm-workspace.yaml"])
    expect(spawn).toHaveBeenCalledWith("pnpm", ["update", "--recursive", "vite-hub", "@vite-hub/*"], expect.objectContaining({ cwd: root, stdout: "stderr" }))
    expect(JSON.parse(await readFile(join(root, "site/package.json"), "utf8")).dependencies).toEqual({ "@vite-hub/agent": "^0.1.0", "nuxt": "^5.0.0", "vite-hub": "catalog:" })
    expect(JSON.parse(await readFile(join(root, "cli/package.json"), "utf8")).devDependencies).toEqual({ "@vite-hub/cli": "0.1.0" })
    // @vite-hub/kit has no npm release, so its override goes. Comments, other entries, and pinned other packages stay.
    expect(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(`packages:
  - site
  - cli

catalog:
  vite-hub: ^0.1.0
  vue: ^3.5.0

overrides:
  # vitehub:start
  "vite-hub": 0.1.0
  "@vite-hub/env": 0.1.0
  # vitehub:end
  # Keep one h3.
  h3: 2.0.8

minimumReleaseAgeExclude:
  - 'vite-hub'
  - '@vite-hub/*'
  - 'comark@0.9.0'
  - nostics@1.4.0
`)
  })

  it("moves every ViteHub package to one pkg.pr.new build with --preview", async () => {
    const root = await pnpmWorkspace()
    const { fetch, requests } = registry({ ...released, "@vite-hub/kit": "0.0.0" })
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const result = await runSetup<SetupUpdatePlan>(["update", "--preview", sha, "--json"], root, {}, { fetch, spawn })

    expect(result.exitCode, result.stderr + result.stdout).toBe(0)
    expect(result.json.target).toEqual({ preview: sha })
    expect(requests.every(request => request.startsWith("HEAD https://pkg.pr.new/"))).toBe(true)
    expect(JSON.parse(await readFile(join(root, "site/package.json"), "utf8")).dependencies["@vite-hub/agent"]).toBe(preview("@vite-hub/agent"))
    expect(JSON.parse(await readFile(join(root, "cli/package.json"), "utf8")).devDependencies["@vite-hub/cli"]).toBe(preview("@vite-hub/cli"))
    const yaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf8")
    expect(yaml).toContain(`  vite-hub: ${preview("vite-hub")}\n`)
    expect(yaml).toContain(`  "@vite-hub/kit": ${preview("@vite-hub/kit")}\n`)
    // pnpm 11 blocks tarball URLs in subdependencies, and preview builds depend on each other by URL.
    expect(yaml.endsWith("\n# pkg.pr.new builds depend on other pkg.pr.new builds.\nblockExoticSubdeps: false\n")).toBe(true)
    // A preview does not install npm releases, so the release-age list stays as it is.
    expect(yaml).toContain("  - 'vite-hub@0.0.4'\n")
  })

  it("prints the diff and the install command without writing with --dry-run", async () => {
    const root = await pnpmWorkspace()
    const { fetch } = registry(released)
    const result = await runSetup(["update", "--dry-run"], root, {}, { fetch })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain("--- a/site/package.json\n+++ b/site/package.json")
    expect(result.stdout).toContain("-    \"@vite-hub/agent\": \"^0.0.4\",\n+    \"@vite-hub/agent\": \"^0.1.0\",")
    expect(result.stdout).toContain("Install: pnpm update --recursive vite-hub \"@vite-hub/*\"\n")
    expect(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(workspaceYaml)
  })

  it("changes nothing when a dependency is missing from the target", async () => {
    const root = await pnpmWorkspace()
    const { fetch } = registry({ "@vite-hub/cli": "0.1.0", "@vite-hub/env": "0.1.0", "vite-hub": "0.1.0" })
    const result = await runSetup<{ error: { code: string, why: string } }>(["update", "--json"], root, {}, { fetch })

    expect(result.exitCode).toBe(1)
    expect(result.json.error.code).toBe("CLI_UPDATE_PACKAGE_MISSING")
    expect(result.json.error.why).toContain("@vite-hub/agent, which npm does not have")
    expect(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(workspaceYaml)
  })

  it("updates npm overrides to match their direct dependencies and runs npm install", async () => {
    const manifest = {
      dependencies: { "@vite-hub/kv": "~0.0.4", "vite-hub": "https://pkg.pr.new/vite-hub/vitehub/vite-hub@caff6eb" },
      name: "app",
      overrides: { "@vite-hub/kv": "~0.0.4", "@vite-hub/runtime": "0.0.4", "vite-hub": { ".": "https://pkg.pr.new/vite-hub/vitehub/vite-hub@caff6eb", "@vite-hub/env": "0.0.4" } },
    }
    const root = await createProject({ "package-lock.json": "{}", "package.json": `${JSON.stringify(manifest, null, "\t")}\n` })
    const { fetch } = registry({ "@vite-hub/env": "0.1.0", "@vite-hub/kv": "0.1.0", "@vite-hub/runtime": "0.1.0", "vite-hub": "0.1.0" })
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const result = await runSetup(["update"], root, {}, { fetch, spawn })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe("Moved 4 ViteHub packages to 0.1.0. Changed package.json.\n")
    expect(spawn).toHaveBeenCalledWith("npm", ["install"], expect.any(Object))
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(`${JSON.stringify({
      dependencies: { "@vite-hub/kv": "~0.1.0", "vite-hub": "^0.1.0" },
      name: "app",
      // npm rejects an override of a direct dependency with another specifier (EOVERRIDE), so those copy the dependency.
      overrides: { "@vite-hub/kv": "~0.1.0", "@vite-hub/runtime": "0.1.0", "vite-hub": { ".": "^0.1.0", "@vite-hub/env": "0.1.0" } },
    }, null, "\t")}\n`)
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(false)
  })

  it("adds the release-age patterns to a pnpm project without a workspace file", async () => {
    const root = await createProject({ "package.json": JSON.stringify({ dependencies: { "vite-hub": "^0.0.4" }, packageManager: "pnpm@11.18.0" }) })
    const { fetch } = registry(released)
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const result = await runSetup(["update", "--no-install"], root, {}, { fetch, spawn })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe("Moved 1 ViteHub package to 0.1.0. Changed package.json, pnpm-workspace.yaml.\nInstall the packages: pnpm update vite-hub \"@vite-hub/*\"\n")
    expect(spawn).not.toHaveBeenCalled()
    expect(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")).toBe("# Let new ViteHub releases install without waiting for minimumReleaseAge.\nminimumReleaseAgeExclude:\n  - 'vite-hub'\n  - '@vite-hub/*'\n")
  })

  it("updates the whole workspace from a workspace package", async () => {
    const root = await pnpmWorkspace()
    const { fetch } = registry(released)
    const result = await runSetup<SetupUpdatePlan>(["update", "--no-install", "--json"], join(root, "site"), {}, { fetch })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json.root).toBe(root)
    expect(JSON.parse(await readFile(join(root, "cli/package.json"), "utf8")).devDependencies["@vite-hub/cli"]).toBe("0.1.0")
  })

  it("updates the whole npm workspace from a workspace package", async () => {
    const root = await createProject({
      "package-lock.json": "{}",
      "package.json": JSON.stringify({ name: "shop", overrides: { "@vite-hub/env": "0.0.4" }, workspaces: ["apps/*"] }),
      "apps/admin/package.json": JSON.stringify({ dependencies: { "@vite-hub/kv": "^0.0.4" }, name: "admin" }),
      "apps/site/package.json": JSON.stringify({ dependencies: { "vite-hub": "^0.0.4" }, name: "site" }),
    })
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const result = await runSetup<SetupUpdatePlan>(["update", "--json"], join(root, "apps/site"), {}, { ...registry({ ...released, "@vite-hub/kv": "0.1.0" }), spawn })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json.root).toBe(root)
    expect(result.json.changes.map(change => change.path)).toEqual(["package.json", "apps/admin/package.json", "apps/site/package.json"])
    expect(spawn).toHaveBeenCalledWith("npm", ["install"], expect.objectContaining({ cwd: root }))
  })

  it("keeps a nested project that its parent does not list as a workspace on its own", async () => {
    const root = await createProject({
      "package-lock.json": "{}",
      "package.json": JSON.stringify({ dependencies: { "vite-hub": "^0.0.4" }, workspaces: ["apps/*"] }),
      "tools/demo/package.json": JSON.stringify({ dependencies: { "vite-hub": "^0.0.4" } }),
    })
    const result = await runSetup<SetupUpdatePlan>(["update", "--no-install", "--json"], join(root, "tools/demo"), {}, registry(released))

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json.root).toBe(join(root, "tools/demo"))
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies["vite-hub"]).toBe("^0.0.4")
  })

  it("reports a project that is already on the target and installs nothing", async () => {
    const root = await createProject({ "package-lock.json": "{}", "package.json": JSON.stringify({ dependencies: { "vite-hub": "^0.1.0" } }) })
    const { fetch } = registry(released)
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const result = await runSetup(["update"], root, {}, { fetch, spawn })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe("ViteHub packages already use 0.1.0. Nothing to change.\n")
    expect(spawn).not.toHaveBeenCalled()
  })

  it("fails without a ViteHub package and for a --preview that is not a commit", async () => {
    const root = await createProject({ "package-lock.json": "{}", "package.json": JSON.stringify({ dependencies: { "vite-hub": "workspace:*", "vue": "^3.5.0" } }) })
    const none = await runSetup<{ error: { code: string } }>(["update", "--json"], root, {}, registry(released))
    expect(none.exitCode).toBe(1)
    expect(none.json.error.code).toBe("CLI_UPDATE_NO_PACKAGES")

    const invalid = await runSetup<{ error: { code: string } }>(["update", "--preview", "main", "--json"], root)
    expect(invalid.exitCode).toBe(1)
    expect(invalid.json.error.code).toBe("CLI_R0003")
  })

  it("keeps the new versions and names the install command when the install fails", async () => {
    const root = await createProject({ "package-lock.json": "{}", "package.json": JSON.stringify({ dependencies: { "vite-hub": "^0.0.4" } }) })
    const spawn = vi.fn(async () => ({ exitCode: 1 }))
    const result = await runSetup<{ error: { code: string, fix: string } }>(["update", "--json"], root, {}, { ...registry(released), spawn })

    expect(result.exitCode).toBe(1)
    expect(result.json.error.code).toBe("CLI_UPDATE_INSTALL_FAILED")
    expect(result.json.error.fix).toContain("then run `npm install`")
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies).toEqual({ "vite-hub": "^0.1.0" })
  })

  it("reports a registry that does not answer", async () => {
    const root = await createProject({ "package-lock.json": "{}", "package.json": JSON.stringify({ dependencies: { "vite-hub": "^0.0.4" } }) })
    const fetch = vi.fn(async () => new Response("busy", { status: 503 })) as typeof globalThis.fetch
    const result = await runSetup<{ error: { code: string, why: string } }>(["update", "--json"], root, {}, { fetch })

    expect(result.exitCode).toBe(1)
    expect(result.json.error.code).toBe("CLI_UPDATE_REQUEST_FAILED")
    expect(result.json.error.why).toContain("https://registry.npmjs.org/vite-hub/latest failed (503)")
  })
})
