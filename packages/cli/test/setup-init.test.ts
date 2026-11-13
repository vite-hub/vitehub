import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
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

type InitResult = SetupInitPlan & { error?: SetupError, missing?: SetupMissing[], rerun?: string }
type StatusResult = SetupStatus & { stack: { command: string } | null }

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
    const fixture = (await readFile(join(installation, "vite.config.ts"), "utf8")).replace("vitehub({ host: \"node\" })", "VITEHUB")
    const config = files["vite.config.ts"]!
    expect(config.replace(/vitehub\(\{.*\}\)/u, "VITEHUB")).toBe(fixture)
    expect(locateViteHubConfig("vite.config.ts", config)).toMatchObject({
      ok: true,
      site: { keys: { host: { value: host }, ...Object.fromEntries(features.map(id => [id, { value: true }])) } },
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
    const args = ["my-app", "--host", "vercel", "--features", "kv,queue", "--option", "kv.driver=upstash", "--no-install", "--yes"]
    expect((await init(args, parent)).exitCode).toBe(0)
    const before = await snapshot(join(parent, "my-app"))

    const again = await init(args, parent)
    expect(again.exitCode, again.stdout).toBe(0)
    expect(again.json).toMatchObject({ changes: [], mode: "adopt", status: "unchanged" })
    expect(await snapshot(join(parent, "my-app"))).toEqual(before)
  })

  it("writes the reproducing command into README.md", async () => {
    const parent = await createProject()
    const result = await init(["shop", "--host", "vercel", "--features", "kv", "--option", "kv.driver=upstash", "--no-install", "--yes"], parent)
    expect(result.exitCode, result.stdout).toBe(0)
    const command = "pnpm dlx vite-hub init shop --host vercel --features kv --option kv.driver=upstash --yes"
    expect(result.json.stack).toEqual({ command })
    const readme = await readFile(join(parent, "shop/README.md"), "utf8")
    expect(readme).toBe(`# shop\n\n<!-- vitehub:stack -->\nCreate the same stack with:\n\n\`\`\`sh\n${command}\n\`\`\`\n<!-- /vitehub:stack -->\n`)
    const status = await runSetup<StatusResult>(["status", "--json"], join(parent, "shop"))
    expect(status.json.stack).toEqual({ command })
  })

  it("refuses the removed --console flag", async () => {
    const parent = await createProject()
    const result = await init(["app", "--host", "node", "--features", "", "--console", "p_1:sha256:abc", "--yes"], parent)
    expect(result.exitCode).not.toBe(0)
    expect(result.json.error).toMatchObject({ code: "CLI_R0003" })
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
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe("import { defineConfig } from 'vite'\nimport { vitehub } from 'vite-hub'\n\nexport default defineConfig({\n  server: { port: 4000 },\n  plugins: [vitehub({ host: 'cloudflare', kv: true })],\n})\n")
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.vitehub\n")
    expect(await readFile(join(root, "README.md"), "utf8")).toMatch(/^# Shop\n\nMy app.\n\n<!-- vitehub:stack -->\n/u)
    expect(await readFile(join(root, "index.html"), "utf8")).toBe("<div id=app></div>\n")
    // vite is declared, so only the missing base packages install.
    expect(result.json.install.devPackages).toEqual(["typescript@^6", "@types/node@^24"])
  })

  it("leaves an app untouched when a root spread can override its plugins", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ devDependencies: { vite: "^8.0.0" }, type: "module" }),
      "vite.config.ts": "export default { plugins: [], ...shared }\n",
    })
    const before = await snapshot(root)
    const result = await init([".", "--host", "node", "--features", "kv", "--no-install", "--yes"], root)
    expect(result.exitCode).toBe(3)
    expect(result.json.error).toMatchObject({ code: "SETUP_CONFIG_MANUAL" })
    expect(await snapshot(root)).toEqual(before)
  })

  it.each(["vite", "nuxt"] as const)("adopts a %s app with a namespace registration without adding another plugin", async (framework) => {
    const config = framework === "nuxt"
      ? 'import * as hub from "vite-hub/nuxt"\nexport default { modules: [[hub.default, { host: "node" }]] }\n'
      : 'import * as hub from "vite-hub"\nexport default { plugins: [hub.vitehub({ host: "node" })] }\n'
    const file = `${framework}.config.ts`
    const root = await createProject({
      "package.json": JSON.stringify({ devDependencies: { [framework]: framework === "nuxt" ? "^5.0.0" : "*" }, type: "module" }),
      [file]: config,
    })
    const args = [".", "--host", "cloudflare", "--features", "kv", "--no-install", "--yes"]
    const result = await init(args, root)
    expect(result.exitCode, result.stdout).toBe(0)
    const after = await readFile(join(root, file), "utf8")
    expect(after).toBe(config.replace('host: "node"', 'host: "cloudflare", kv: true'))
    const again = await init(args, root)
    expect(again.exitCode, again.stdout).toBe(0)
    expect(again.json).toMatchObject({ changes: [], status: "unchanged" })
  })

  it.each(["vite", "nuxt"] as const)("leaves host migration of an existing %s stack manual", async (framework) => {
    for (const options of ["browser: true", 'cache: { driver: "cloudflare-kv-binding" }', "browser: browserOptions"]) {
      const config = framework === "nuxt"
        ? `export default { modules: [["vite-hub/nuxt", { host: "cloudflare", ${options} }]] }\n`
        : `import { vitehub } from "vite-hub"\nexport default { plugins: [vitehub({ host: "cloudflare", ${options} })] }\n`
      const root = await createProject({ "package.json": JSON.stringify({ dependencies: { [framework]: framework === "nuxt" ? "^5.0.0" : "*" } }), [`${framework}.config.ts`]: config })
      const before = await snapshot(root)
      const calls: string[] = []
      const result = await init([".", "--host", "node", "--features", "kv", "--yes"], root, async (command) => {
        calls.push(command)
        return { exitCode: 0 }
      })
      expect(result.exitCode, result.stdout).toBe(3)
      expect(result.json.error?.code).toBe("SETUP_INIT_HOST_MIGRATION")
      expect(calls).toEqual([])
      expect(await snapshot(root)).toEqual(before)
    }
  })

  it.each([["vite", false], ["nuxt", false], ["nuxt", true]] as const)("adopts a config-less %s app without replacing existing files (unrelated Vite config: %s)", async (framework, unrelatedViteConfig) => {
    const root = await createProject({
      "package.json": JSON.stringify({ devDependencies: { [framework]: framework === "nuxt" ? "^5.0.0" : "*" }, type: "module" }),
      "index.html": "<div id=app></div>\n",
      ...(unrelatedViteConfig ? { "vite.config.ts": "export default { plugins: [] }\n" } : {}),
    })
    const before = await snapshot(root)
    const args = [".", "--host", "cloudflare", "--features", "kv", "--no-install", "--yes"]
    const file = `${framework}.config.ts`

    const dryRun = await init([...args, "--dry-run"], root)
    expect(dryRun.exitCode, dryRun.stdout).toBe(0)
    expect(dryRun.json.changes).toContainEqual(expect.objectContaining({ kind: "create", path: file }))
    expect(await snapshot(root)).toEqual(before)

    const result = await init(args, root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json).toMatchObject({ framework, mode: "adopt", status: "applied" })
    expect(locateViteHubConfig(file, await readFile(join(root, file), "utf8"))).toMatchObject({
      ok: true,
      site: { keys: { kv: { value: true }, host: { value: "cloudflare" } } },
    })
    const after = await snapshot(root)
    expect(after).toMatchObject(before)
    const again = await init(args, root)
    expect(again.exitCode, again.stdout).toBe(0)
    expect(again.json).toMatchObject({ changes: [], status: "unchanged" })
    expect(await snapshot(root)).toEqual(after)
  })

  it.each(["vite", "nuxt"] as const)("does not create a config for a config-less %s app when feature planning fails", async (framework) => {
    const root = await createProject({ "package.json": JSON.stringify({ dependencies: { [framework]: framework === "nuxt" ? "^5.0.0" : "*" } }) })
    const before = await snapshot(root)
    const result = await init([".", "--host", "node", "--features", "browser", "--no-install", "--yes"], root)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_FEATURE_UNSUPPORTED")
    expect(await snapshot(root)).toEqual(before)
  })

  it("leaves a config-less Nuxt app with local layers manual", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { nuxt: "^5.0.0" } }),
      "layers/base/nuxt.config.ts": 'export default { modules: ["vite-hub/nuxt"] }\n',
    })
    const before = await snapshot(root)
    const result = await init([".", "--host", "node", "--features", "kv", "--no-install", "--yes"], root)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_CONFIG_MANUAL")
    expect(await snapshot(root)).toEqual(before)
  })

  it.each([
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
  ])("honors parent lockfiles (%s) when creating missing and empty apps", async (lockfile, pm) => {
    const parent = await createProject({ [lockfile]: "" })
    await mkdir(join(parent, "empty-app"))
    for (const dir of ["missing-app", "empty-app"]) {
      const result = await runSetup<InitResult>(["init", dir, "--host", "node", "--features", "kv", "--framework", "nuxt", "--dry-run", "--json"], parent, { npm_config_user_agent: "pnpm/10.0.0" })
      expect(result.exitCode, result.stdout).toBe(0)
      expect(result.json.packageManager).toBe(pm)
      expect(result.json.scaffold?.command).toContain(`--packageManager ${pm}`)
      expect(result.json.install.command).toMatch(new RegExp(`^${pm} `))
    }
  })

  it.each([
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
  ])("keeps the inherited manager from %s in the README and status outside the parent tree", async (lockfile, pm) => {
    const parent = await createProject({ [lockfile]: "" })
    const calls: string[] = []
    const result = await runSetup<InitResult>(["init", "app", "--host", "node", "--features", "kv", "--yes", "--json"], parent, { npm_config_user_agent: "pnpm/10.0.0" }, {
      spawn: async (command) => {
        calls.push(command)
        return { exitCode: 0 }
      },
    })
    expect(result.exitCode, result.stdout).toBe(0)
    expect(calls).toEqual([pm, pm])
    const command = `pnpm dlx vite-hub init app --host node --features kv --pm ${pm} --yes`
    expect(result.json.stack.command).toBe(command)
    expect(await readFile(join(parent, "app/README.md"), "utf8")).toContain(command)

    const movedParent = await createProject()
    await rename(join(parent, "app"), join(movedParent, "app"))
    const status = await runSetup<StatusResult>(["status", "--json"], join(movedParent, "app"))
    expect(status.exitCode, status.stdout).toBe(0)
    expect(status.json.stack).toEqual({ command })
    const replay = await runSetup<InitResult>([...command.split(" ").slice(3), "--dry-run", "--json"], await createProject(), { npm_config_user_agent: "pnpm/10.0.0" })
    expect(replay.exitCode, replay.stdout).toBe(0)
    expect(replay.json.packageManager).toBe(pm)
  })

  it("reports new app files left on disk after installation fails", async () => {
    const parent = await createProject()
    const result = await init(["app", "--host", "node", "--features", "kv", "--yes"], parent, async () => ({ exitCode: 1 }))
    expect(result.exitCode).toBe(1)
    expect(result.json.error).toMatchObject({ code: "SETUP_INSTALL_FAILED" })
    expect(result.json.error?.fix).toContain("app files were written")
    expect(result.json.error?.fix).not.toContain("did not write")
    const files = await snapshot(join(parent, "app"))
    expect(files["package.json"]).toBeDefined()
    expect(files["server/api/health.get.ts"]).toBeDefined()
    expect(files["vite.config.ts"]).toContain("vitehub(")
  })

  it.each([false, true])("reports Nuxt scaffold output after failure (scaffolding succeeded: %s)", async (scaffoldSucceeds) => {
    const parent = await createProject()
    const config = "export default defineNuxtConfig({})\n"
    const spawn: ViteHubCliSpawn = async (_command, args) => {
      if (args.includes("init")) {
        await mkdir(join(parent, "site"))
        await writeFile(join(parent, "site/package.json"), JSON.stringify({ dependencies: { nuxt: "^5.0.0" }, type: "module" }))
        await writeFile(join(parent, "site/nuxt.config.ts"), config)
        return { exitCode: scaffoldSucceeds ? 0 : 1 }
      }
      return { exitCode: 1 }
    }
    const result = await init(["site", "--host", "node", "--features", "kv", "--framework", "nuxt", "--yes"], parent, spawn)
    expect(result.exitCode).toBe(1)
    expect(result.json.error).toMatchObject({ code: "SETUP_INSTALL_FAILED" })
    expect(result.json.error?.fix).not.toContain("did not write")
    expect(result.json.error?.fix).toContain(scaffoldSucceeds ? "app files were written" : "may have left new app files")
    expect(await readFile(join(parent, "site/nuxt.config.ts"), "utf8")).toBe(config)
    expect(existsSync(join(parent, "site/package.json"))).toBe(true)
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

  it.each(["pnpm", "yarn"] as const)("creates a Nuxt app with the pinned nuxi using %s, then adopts it", async (pm) => {
    const parent = await createProject()
    const calls: string[][] = []
    const spawn: ViteHubCliSpawn = async (command, args) => {
      calls.push([command, ...args])
      if (args.includes("init")) {
        // The pinned starter with `nuxi init --nightly 5x` declares the resolved nightly version.
        await mkdir(join(parent, "site/server"), { recursive: true })
        await writeFile(join(parent, "site/package.json"), JSON.stringify({ dependencies: { nuxt: "npm:nuxt-nightly@5.0.0-2611071848-2d8337c", vue: "^3.5.44", "vue-router": "^5.4.0" }, name: "site", private: true, type: "module" }))
        await writeFile(join(parent, "site/nuxt.config.ts"), "// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  compatibilityDate: '2025-07-15',\n  devtools: { enabled: true }\n})\n")
      }
      return { exitCode: 0, signal: null }
    }
    const result = await init(["site", "--host", "vercel", "--features", "kv", "--framework", "nuxt", "--pm", pm, "--yes"], parent, spawn)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(calls[0]).toEqual([...(pm === "yarn" ? ["npx", "--yes"] : ["pnpm", "dlx"]), nuxiPackage, "init", "site", "--template", "gh:nuxt/starter#db01806fcb37f2e369fb09443c72cac696b31548", "--nightly", "5x", "--packageManager", pm, "--no-install", "--no-gitInit", "--no-modules"])
    expect(calls.slice(1)).toEqual([[pm, "add", ...result.json.install.packages]])
    expect(result.json.install.packages.slice(0, initPackages.nuxt.prod.length)).toEqual([...initPackages.nuxt.prod])
    expect(result.json).toMatchObject({ framework: "nuxt", mode: "create", scaffold: { command: expect.stringContaining(nuxiPackage) }, status: "applied" })
    const config = await readFile(join(parent, "site/nuxt.config.ts"), "utf8")
    expect(locateViteHubConfig("nuxt.config.ts", config)).toMatchObject({ ok: true, site: { form: "nuxt-module-tuple", keys: { kv: { value: true }, host: { value: "vercel" } } } })
    expect(result.json.stack.command).toBe(`pnpm dlx vite-hub init site --host vercel --features kv --framework nuxt${pm === "yarn" ? " --pm yarn" : ""} --yes`)
  })

  it.each([undefined, "latest", "6.0.0", "npm:nuxt-nightly@latest"])("rejects a scaffold without a known Nuxt 5 version (%s)", async (nuxt) => {
    const parent = await createProject()
    const files = {
      "package.json": JSON.stringify({ dependencies: { nuxt }, type: "module" }),
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
    }
    const calls: string[] = []
    const result = await init(["site", "--host", "node", "--features", "kv", "--framework", "nuxt", "--yes"], parent, async (command) => {
      calls.push(command)
      await mkdir(join(parent, "site"), { recursive: true })
      for (const [file, text] of Object.entries(files)) await writeFile(join(parent, "site", file), text)
      return { exitCode: 0 }
    })
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_INIT_NUXT_VERSION")
    expect(result.json.error?.fix).toContain("scaffold files remain")
    expect(calls).toHaveLength(1)
    expect(await snapshot(join(parent, "site"))).toEqual(files)
  })

  it.each([
    "5", "5.x", "5.*", "5.1", "~5.1", "^5.1.2", "=5.1.2+local",
    ">=5.0.0 <6.0.0", ">=5.1 <6", "5.1.0 - 5.3.0", "^5.1 || ~5.3",
    "^5.1.0-beta.2", ">=5.1.0-beta.2 <5.1.0", ">=5.0.0-0 <6.0.0-0",
    "npm:nuxt@5.x", "npm:nuxt-nightly@5.0.0-2611071848-2d8337c",
  ])("adopts an existing Nuxt app with the supported range %s", async (nuxt) => {
    for (const dependencyKey of ["dependencies", "devDependencies"]) {
      const manifest = JSON.stringify({ [dependencyKey]: { nuxt }, type: "module" })
      const root = await createProject({
        "package.json": manifest,
        "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      })
      const result = await init([".", "--host", "node", "--features", "kv", "--no-install", "--yes"], root)
      expect(result.exitCode, result.stdout).toBe(0)
      const config = await readFile(join(root, "nuxt.config.ts"), "utf8")
      expect(locateViteHubConfig("nuxt.config.ts", config)).toMatchObject({ ok: true, site: { keys: { kv: { value: true }, host: { value: "node" } } } })
      expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest)
    }
  })

  it.each(["dependencies", "devDependencies"])("rejects an existing Nuxt app without a known Nuxt 5 version in %s before any install or write", async (dependencyKey) => {
    for (const nuxt of [
      undefined, "^4.6.4", "latest", "*", "npm:nuxt-nightly@latest", "npm:other@5.0.0",
      "6.x", ">=5.0.0", ">=5.0.0 <=6.0.0", "5.x || 6.0.0", "5.x || 6.0.0-beta.1",
      ">=5.0.0 <6.0.0-beta.2", ">=5.0.0 <5.0.0", "<0.0.0-0", "not a range",
    ]) {
      const root = await createProject({
        "package.json": JSON.stringify({ [dependencyKey]: { nuxt }, type: "module" }),
        "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      })
      const before = await snapshot(root)
      const calls: string[] = []
      const result = await init([".", "--host", "node", "--features", "kv", "--yes"], root, async (command) => {
        calls.push(command)
        return { exitCode: 0 }
      })
      expect(result.exitCode, result.stdout).toBe(3)
      expect(result.json.error?.code).toBe("SETUP_INIT_NUXT_VERSION")
      expect(result.json.error?.fix).not.toContain("scaffold files")
      expect(calls).toEqual([])
      expect(await snapshot(root)).toEqual(before)
    }
  })

  it("installs the packages that the installation docs list", async () => {
    const docs = await readFile(join(repository, "docs/content/docs/getting-started/installation.md"), "utf8")
    expect(docs).toContain(`pnpm add ${initPackages.vite.prod.join(" ")}\n`)
    expect(docs).toContain(`pnpm add -D ${initPackages.vite.dev.join(" ")}\n`)
    expect(docs).toContain(`pnpm add ${initPackages.nuxt.prod.join(" ")}\n`)
  })
})
