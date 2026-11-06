import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { featureIds, featureSupport } from "@vite-hub/internal/features"
import { describe, expect, it } from "vitest"

import { initPackages, nuxiPackage } from "../src/setup/init.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { SetupError, SetupInitPlan, SetupMissing, SetupStatus } from "../src/setup/index.ts"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const installation = join(repository, "fixtures/docs-hosts/installation")
const hosts = ["cloudflare", "vercel", "netlify", "deno", "node"] as const
const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

type InitResult = SetupInitPlan & { error?: SetupError, missing?: SetupMissing[], rerun?: string }
type StatusResult = SetupStatus & { stack: { command: string } | null, console: { pendingId: string } | null }

function init(args: string[], cwd: string, spawn?: ViteHubCliSpawn) {
  return runSetup<InitResult>(["init", ...args, "--json"], cwd, {}, spawn ? { spawn } : {})
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  return Object.fromEntries(await Promise.all(files.map(async file => [relative(root, file), await readFile(file, "utf8")] as const)))
}

/** Features that build on `host` without an option, a few per host. */
function nativeFeatures(host: typeof hosts[number]): string[] {
  return ["kv", "queue", "blob", "cache"].filter(id => featureSupport(id as "kv", host).level === "native").slice(0, 3)
}

describe("vitehub init", () => {
  it.each(hosts)("creates the installation app for %s", async (host) => {
    const parent = await createProject()
    const features = nativeFeatures(host)
    const result = await init(["my-app", "--host", host, "--features", features.join(","), "--no-install", "--yes"], parent)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.loadConfig).not.toHaveBeenCalled()
    const root = join(parent, "my-app")
    expect(result.json).toMatchObject({ features, framework: "vite", host, mode: "create", root, status: "applied" })

    const files = await snapshot(root)
    expect(Object.keys(files).sort()).toEqual([".gitignore", "README.md", "package.json", "server/api/health.get.ts", "tsconfig.json", "vite.config.ts"])
    expect(JSON.parse(files["package.json"]!)).toEqual({ ...JSON.parse(await readFile(join(installation, "package.fixture.json"), "utf8")), name: "my-app" })
    expect(files["tsconfig.json"]).toBe(await readFile(join(installation, "tsconfig.json"), "utf8"))
    expect(files["server/api/health.get.ts"]).toBe(await readFile(join(installation, "server/api/health.get.ts"), "utf8"))
    expect(files[".gitignore"]!.split("\n")).toContain(".vitehub")

    // The config is the fixture with the host and one key per feature.
    const fixture = (await readFile(join(installation, "vite.config.ts"), "utf8")).replace("vitehub({ preset: \"node\" })", "VITEHUB")
    const config = files["vite.config.ts"]!
    expect(config.replace(/vitehub\(\{.*\}\)/u, "VITEHUB")).toBe(fixture)
    expect(locateViteHubConfig("vite.config.ts", config)).toMatchObject({
      ok: true,
      site: { keys: { preset: { value: host }, ...Object.fromEntries(features.map(id => [id, { value: true }])) } },
    })
    expect(result.json.install.packages).toEqual(expect.arrayContaining([...initPackages.vite.prod]))
    expect(result.json.install.devPackages).toEqual([...initPackages.vite.dev])
    expect(result.json.nextSteps).toContain(`Install the packages: ${result.json.install.command}`)

    // The status reads the same stack back.
    const status = await runSetup<StatusResult>(["status", "--json"], root)
    expect(status.json.host).toEqual({ name: host, source: "config" })
    for (const id of features) expect(status.json.features.find(item => item.id === id)?.enabled).toBe("on")
    expect(status.json.stack).toEqual({ command: `pnpm dlx vite-hub init my-app --host ${host} --features ${features.join(",")} --yes` })
  })

  it("is a no-op when the same command runs again", async () => {
    const parent = await createProject()
    const args = ["my-app", "--host", "vercel", "--features", "kv,queue", "--option", "kv.driver=upstash", "--console", `p_1:sha256:${hash}`, "--no-install", "--yes"]
    expect((await init(args, parent)).exitCode).toBe(0)
    const before = await snapshot(join(parent, "my-app"))

    const again = await init(args, parent)
    expect(again.exitCode, again.stdout).toBe(0)
    expect(again.json).toMatchObject({ changes: [], mode: "adopt", status: "unchanged" })
    expect(await snapshot(join(parent, "my-app"))).toEqual(before)
  })

  it("writes the reproducing command into README.md without the --console value", async () => {
    const parent = await createProject()
    const result = await init(["shop", "--host", "vercel", "--features", "kv", "--option", "kv.driver=upstash", "--console", `pending-42:sha256:${hash}`, "--no-install", "--yes"], parent)
    expect(result.exitCode, result.stdout).toBe(0)
    const command = "pnpm dlx vite-hub init shop --host vercel --features kv --option kv.driver=upstash --yes"
    expect(result.json.stack).toEqual({ command })
    const readme = await readFile(join(parent, "shop/README.md"), "utf8")
    expect(readme).toBe(`# shop\n\n<!-- vitehub:stack -->\nCreate the same stack with:\n\n\`\`\`sh\n${command}\n\`\`\`\n<!-- /vitehub:stack -->\n`)
    expect(readme).not.toContain("pending-42")
    expect(readme).not.toContain(hash)
    const status = await runSetup<StatusResult>(["status", "--json"], join(parent, "shop"))
    expect(status.json.stack).toEqual({ command })
  })

  it("stores only the pendingId and the hash from --console in the gitignored link file", async () => {
    const parent = await createProject()
    const result = await init(["app", "--host", "cloudflare", "--features", "kv", "--console", `p_1:sha256:${hash.toUpperCase()}`, "--no-install", "--yes"], parent)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.console).toEqual({ pendingId: "p_1" })
    const root = join(parent, "app")
    expect(JSON.parse(await readFile(join(root, ".vitehub/link.json"), "utf8"))).toEqual({ console: { pendingId: "p_1", tokenSha256: hash }, schemaVersion: 1 })
    expect((await readFile(join(root, ".gitignore"), "utf8")).split("\n")).toContain(".vitehub")

    const status = await runSetup<StatusResult>(["status", "--json"], root)
    expect(status.json).toMatchObject({ console: { pendingId: "p_1" }, link: null })
    expect(status.stdout).not.toContain(hash)
    // Unlink removes a host link only. The pending Console link stays.
    expect((await runSetup(["unlink", "--json"], root)).json).toMatchObject({ removed: false })
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(true)
  })

  it.each([
    "vh_live_4f2c9a1b8e7d",
    `p_1:${hash}`,
    `p_1:sha256:${hash.slice(1)}`,
    `p_1:sha1:${hash}`,
    `bad id:sha256:${hash}`,
    `p/1:sha256:${hash}`,
  ])("rejects --console %s with exit 1 and never prints it", async (value) => {
    const parent = await createProject()
    const result = await init(["app", "--host", "node", "--features", "", "--console", value, "--yes"], parent)
    expect(result.exitCode).toBe(1)
    expect(result.json.error).toMatchObject({ code: "SETUP_CONSOLE_INVALID" })
    expect(result.stdout + result.stderr).not.toContain(value)
    expect(existsSync(join(parent, "app"))).toBe(false)
  })

  it("names the flag and its choices without a terminal", async () => {
    const parent = await createProject()
    const json = await init(["app", "--features", "kv", "--yes"], parent)
    expect(json.exitCode).toBe(2)
    expect(json.json.error).toMatchObject({ code: "SETUP_INPUT_NEEDED", message: "Pass --host (cloudflare, vercel, netlify, deno, node) when running without an interactive terminal." })
    expect(json.json.missing).toEqual([{ choices: [...hosts], field: "host" }])
    expect(json.json.rerun).toBe("pnpm dlx vite-hub init app --host <host> --features kv --yes --json")

    const text = await runSetup(["init", "app", "--features", "kv", "--yes"], parent)
    expect(text.exitCode).toBe(2)
    expect(text.stderr).toContain("Pass --host (cloudflare, vercel, netlify, deno, node) when running without an interactive terminal.")
    expect(existsSync(join(parent, "app"))).toBe(false)

    const none = await init([], parent)
    expect(none.json.missing?.map(item => item.field)).toEqual(["dir", "host", "features"])
  })

  it("prints the plan and exits 2 without --yes and without a terminal", async () => {
    const parent = await createProject()
    const result = await init(["app", "--host", "node", "--features", "kv"], parent)
    expect(result.exitCode).toBe(2)
    expect(result.json).toMatchObject({ error: { code: "CLI_R0004" }, rerun: "pnpm dlx vite-hub init app --host node --features kv --yes --json", status: "planned" })
    expect(existsSync(join(parent, "app"))).toBe(false)
  })

  it("fails an unsupported host pair before any write", async () => {
    const [host, id] = hosts.flatMap(name => featureIds.filter(item => featureSupport(item, name).level === "unsupported").map(item => [name, item] as const))[0]!
    const parent = await createProject()
    const result = await init(["app", "--host", host, "--features", `kv,${id}`, "--no-install", "--yes"], parent)
    expect(result.exitCode).toBe(3)
    expect(result.json.error).toMatchObject({ code: "SETUP_FEATURE_UNSUPPORTED" })
    expect(existsSync(join(parent, "app"))).toBe(false)
  })

  it("asks for a provider option with an init rerun", async () => {
    const parent = await createProject()
    const result = await init(["app", "--host", "vercel", "--features", "email", "--no-install", "--yes"], parent)
    expect(result.exitCode).toBe(2)
    expect(result.json.missing).toEqual([{ choices: ["resend"], field: "email.driver" }])
    expect(result.json.rerun).toBe("pnpm dlx vite-hub init app --host vercel --features email --option email.driver=resend --no-install --yes --json")
    expect(existsSync(join(parent, "app"))).toBe(false)
  })

  it("adopts an existing Vite app without overwriting a file", async () => {
    const root = await createProject({
      ".gitignore": "node_modules\n",
      "README.md": "# Shop\n\nMy app.\n",
      "index.html": "<div id=app></div>\n",
      "package.json": JSON.stringify({ devDependencies: { vite: "^8.0.0" }, name: "shop", packageManager: "pnpm@10.0.0", type: "module" }),
      "vite.config.ts": "import { defineConfig } from 'vite'\n\nexport default defineConfig({\n  server: { port: 4000 },\n})\n",
    })
    const result = await init([".", "--host", "cloudflare", "--features", "kv", "--no-install", "--yes"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json).toMatchObject({ mode: "adopt", status: "applied" })
    expect(result.json.changes.map(change => [change.path, change.kind])).toEqual([["README.md", "patch"], [".gitignore", "patch"], ["vite.config.ts", "patch"]])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe("import { defineConfig } from 'vite'\nimport { vitehub } from 'vite-hub'\n\nexport default defineConfig({\n  server: { port: 4000 },\n  plugins: [vitehub({ preset: 'cloudflare', kv: true })],\n})\n")
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.vitehub\n")
    expect(await readFile(join(root, "README.md"), "utf8")).toMatch(/^# Shop\n\nMy app.\n\n<!-- vitehub:stack -->\n/u)
    expect(await readFile(join(root, "index.html"), "utf8")).toBe("<div id=app></div>\n")
    // vite is declared, so only the missing base packages install.
    expect(result.json.install.devPackages).toEqual(["typescript@^6", "@types/node@^24"])
  })

  it("refuses a folder that is not empty and holds no app", async () => {
    const parent = await createProject({ "app/notes.txt": "keep me\n" })
    const result = await init(["app", "--host", "node", "--features", "kv", "--yes"], parent)
    expect(result.exitCode).toBe(3)
    expect(result.json.error).toMatchObject({ code: "SETUP_INIT_DIR_NOT_EMPTY" })
    expect(await snapshot(join(parent, "app"))).toEqual({ "notes.txt": "keep me\n" })
  })

  it("installs the pinned packages with the package manager after writing package.json", async () => {
    const parent = await createProject()
    const calls: { command: string, args: string[], cwd?: string, manifest: boolean }[] = []
    const spawn: ViteHubCliSpawn = async (command, args, options) => {
      calls.push({ args, command, cwd: options?.cwd, manifest: existsSync(join(parent, "app/package.json")) })
      return { exitCode: 0, signal: null }
    }
    const result = await init(["app", "--host", "cloudflare", "--features", "kv", "--pm", "npm", "--yes"], parent, spawn)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages.slice(0, initPackages.vite.prod.length)).toEqual([...initPackages.vite.prod])
    expect(calls).toEqual([
      { args: ["install", ...result.json.install.packages], command: "npm", cwd: join(parent, "app"), manifest: true },
      { args: ["install", "-D", ...initPackages.vite.dev], command: "npm", cwd: join(parent, "app"), manifest: true },
    ])
    expect(result.json.stack.command).toBe("pnpm dlx vite-hub init app --host cloudflare --features kv --pm npm --yes")
  })

  it("creates a Nuxt app with the pinned nuxi, then adopts it", async () => {
    const parent = await createProject()
    const calls: string[][] = []
    const spawn: ViteHubCliSpawn = async (command, args) => {
      calls.push([command, ...args])
      if (args.includes("init")) {
        // What `nuxi init --template minimal` writes.
        await mkdir(join(parent, "site/server"), { recursive: true })
        await writeFile(join(parent, "site/package.json"), JSON.stringify({ dependencies: { nuxt: "^4.5.2", vue: "^3.5.0" }, name: "site", private: true, type: "module" }))
        await writeFile(join(parent, "site/nuxt.config.ts"), "// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  compatibilityDate: '2025-07-15',\n  devtools: { enabled: true }\n})\n")
      }
      return { exitCode: 0, signal: null }
    }
    const result = await init(["site", "--host", "vercel", "--features", "kv", "--framework", "nuxt", "--yes"], parent, spawn)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(calls[0]).toEqual(["pnpm", "dlx", nuxiPackage, "init", "site", "--template", "minimal", "--packageManager", "pnpm", "--no-install", "--no-gitInit", "--no-modules"])
    expect(calls.slice(1)).toEqual([["pnpm", "add", ...result.json.install.packages]])
    expect(result.json.install.packages.slice(0, 2)).toEqual([...initPackages.nuxt.prod])
    expect(result.json).toMatchObject({ framework: "nuxt", mode: "create", scaffold: { command: expect.stringContaining(nuxiPackage) }, status: "applied" })
    const config = await readFile(join(parent, "site/nuxt.config.ts"), "utf8")
    expect(locateViteHubConfig("nuxt.config.ts", config)).toMatchObject({ ok: true, site: { form: "nuxt-module-tuple", keys: { kv: { value: true }, preset: { value: "vercel" } } } })
    expect(result.json.stack.command).toBe("pnpm dlx vite-hub init site --host vercel --features kv --framework nuxt --yes")
  })

  it("installs the packages that the installation docs list", async () => {
    const docs = await readFile(join(repository, "docs/content/docs/getting-started/installation.md"), "utf8")
    expect(docs).toContain(`pnpm add ${initPackages.vite.prod.join(" ")}\n`)
    expect(docs).toContain(`pnpm add -D ${initPackages.vite.dev.join(" ")}\n`)
    expect(docs).toContain(`pnpm add ${initPackages.nuxt.prod.join(" ")}\n`)
  })
})
