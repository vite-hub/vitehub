import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { featureIds, featureSupport } from "@vite-hub/internal/features"
import { describe, expect, it } from "vitest"

import { createProject, runSetup } from "./setup-helpers.ts"

import type { DeploymentPreset } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import type { SetupAddPlan, SetupError, SetupLinkResult, SetupMissing, SetupStatus } from "../src/setup/index.ts"

/**
 * The setup commands on every host preset, in the Vite form (`vitehub()` in vite.config) and the Nuxt form
 * (`vite-hub/nuxt` module tuple). Each case runs on a temp copy of a `fixtures/docs-hosts` config.
 */

const docsHosts = fileURLToPath(new URL("../../../fixtures/docs-hosts/", import.meta.url))
const manifest = JSON.stringify({ name: "my-app", type: "module" })

type Host = Exclude<DeploymentPreset, "dev">

interface HostForm {
  host: Host
  framework: "vite" | "nuxt"
  configFile: "vite.config.ts" | "nuxt.config.ts"
  config: () => Promise<string>
}

const viteFixtures: Record<Host, string> = {
  cloudflare: "cloudflare",
  deno: "deno",
  netlify: "netlify",
  node: "node-self-hosted",
  vercel: "vercel",
}
const hosts = Object.keys(viteFixtures) as Host[]

const forms: HostForm[] = hosts.flatMap(host => [
  { config: () => readFile(join(docsHosts, viteFixtures[host], "vite.config.ts"), "utf8"), configFile: "vite.config.ts", framework: "vite", host },
  {
    config: async () => {
      const nuxt = await readFile(join(docsHosts, "installation/nuxt.config.ts"), "utf8")
      expect(nuxt).toContain(`[viteHubNuxt, { preset: "node" }]`)
      return nuxt.replace(`preset: "node"`, `preset: "${host}"`)
    },
    configFile: "nuxt.config.ts",
    framework: "nuxt",
    host,
  },
] as const)

/** Values that only the developer knows. `add` asks for them without a `rerun`. */
const developerInputs: Record<string, readonly string[]> = {
  "blob.driver": ["--option", "blob.driver=s3", "--option", "blob.bucket=app-assets"],
  "database.connection": ["--option", "database.connection.url=libsql://example.com"],
  "workspace.store": ["--option", "workspace.store.provider=github", "--option", "workspace.store.repository=owner/repo"],
}

type AddResult = SetupAddPlan & { error?: SetupError, missing?: SetupMissing[], rerun?: string }

async function project(form: HostForm): Promise<string> {
  return await createProject({ "package.json": manifest, [form.configFile]: await form.config() })
}

async function add(args: readonly string[], root: string) {
  return await runSetup<AddResult>(["add", ...args, "--no-install", "--yes", "--json"], root)
}

/** The arguments of a `rerun`, without the `vitehub` word and the flags that `add` appends. */
function rerunArgs(rerun: string): string[] {
  return rerun.split(" ").slice(2).filter(arg => !["--no-install", "--yes", "--json"].includes(arg))
}

/**
 * Adds `id` and follows the input that `add` asks for: a `rerun` when ViteHub can choose the values, else the
 * developer inputs above. Returns the arguments that succeeded and what the first run asked for.
 */
async function addFeature(id: FeatureId, root: string): Promise<{ args: string[], first: AddResult, firstExit: number, result: AddResult }> {
  const first = await add([id], root)
  expect(first.loadConfig).not.toHaveBeenCalled()
  if (first.exitCode !== 2) return { args: [id], first: first.json, firstExit: first.exitCode, result: first.json }
  let args: string[]
  if (first.json.rerun) {
    expect(first.json.rerun).toMatch(/^vitehub add /u)
    args = rerunArgs(first.json.rerun)
  }
  else {
    const fields = (first.json.missing ?? []).map(item => item.field)
    for (const field of fields) expect(developerInputs, `${id} asks for ${field}`).toHaveProperty([field])
    args = [id, ...fields.flatMap(field => developerInputs[field]!)]
  }
  const second = await add(args, root)
  expect(second.exitCode, `${id} ${args.join(" ")}: ${JSON.stringify(second.json.error)}`).toBe(0)
  return { args, first: first.json, firstExit: 2, result: second.json }
}

describe.each(forms)("setup commands on $host ($framework)", (form) => {
  it("reads the host from config and the support of every feature from the catalog", async () => {
    const root = await project(form)

    const { exitCode, json, loadConfig } = await runSetup<SetupStatus>(["status", "--json"], root)

    expect(exitCode).toBe(0)
    expect(loadConfig).not.toHaveBeenCalled()
    expect(json.framework).toBe(form.framework)
    expect(json.host).toEqual({ name: form.host, source: "config" })
    expect(json.config).toMatchObject({ file: form.configFile })
    expect(json.features.map(item => item.id)).toEqual([...featureIds])
    for (const item of json.features) expect(item.support, item.id).toEqual(featureSupport(item.id, form.host))
  })

  it("adds every supported feature once and rejects the unsupported ones", async () => {
    const results: Record<string, string> = {}
    for (const id of featureIds) {
      const support = featureSupport(id, form.host)
      const root = await project(form)
      const before = await readFile(join(root, form.configFile), "utf8")

      if (support.level === "unsupported") {
        const { exitCode, json } = await add([id], root)
        expect(exitCode, id).toBe(3)
        expect(json.error, id).toMatchObject({ code: "SETUP_FEATURE_UNSUPPORTED" })
        expect(await readFile(join(root, form.configFile), "utf8"), id).toBe(before)
        expect(existsSync(join(root, ".vitehub")), id).toBe(false)
        results[id] = "unsupported: exit 3"
        continue
      }

      const { args, first, firstExit, result } = await addFeature(id, root)
      if (support.level === "explicit") {
        expect(firstExit, `${id} without ${support.option}`).toBe(2)
        expect(first.error?.code, id).toBe("SETUP_INPUT_NEEDED")
        expect(first.missing?.map(item => item.field), id).toContain(support.option)
      }
      else {
        expect([0, 2], `${id}: ${JSON.stringify(first.error)}`).toContain(firstExit)
      }
      // Input-needed runs write nothing.
      if (firstExit === 2) expect(first.changes ?? [], id).toEqual([])

      const after = await readFile(join(root, form.configFile), "utf8")
      if (result.status === "applied") {
        const patch = result.changes.find(change => change.path === form.configFile)
        expect(patch, id).toMatchObject({ after, before, kind: "patch" })
        expect(patch!.diff, id).toMatch(new RegExp(`^\\+.*\\b${id}: (true|\\{)`, "mu"))
      }
      else {
        expect(result.status, id).toBe("unchanged")
        expect(after, id).toBe(before)
      }
      const status = (await runSetup<SetupStatus>(["status", "--json"], root)).json
      expect(status.features.find(item => item.id === id)?.enabled, id).toBe("on")

      // A second run changes nothing.
      const again = await add(args, root)
      expect(again.exitCode, id).toBe(0)
      expect(again.json, id).toMatchObject({ changes: [], status: "unchanged" })
      expect(await readFile(join(root, form.configFile), "utf8"), id).toBe(after)
      results[id] = `${support.level}: ${firstExit === 0 ? result.status : `exit 2, then ${first.rerun ? "rerun" : "developer input"}`}`
    }
    expect(Object.keys(results)).toEqual([...featureIds])
  }, 60_000)

  it("links the project on the host and unlinks it", async () => {
    const root = await project(form)
    const token = "test-token-hosts"
    const cloudflareAccount = "023e105f4ecef8ad9ca31a8372d0c353"
    const answers: Record<string, string> = {
      [`GET https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/workers/workers/my-app`]: "cloudflare-worker.json",
      "GET https://api.netlify.com/api/v1/sites": "netlify-sites.json",
      "GET https://api.vercel.com/v9/projects/my-app": "vercel-project.json",
    }
    const requests: string[] = []
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      const route = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`
      requests.push(route)
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`)
      const fixture = answers[route]
      if (!fixture) throw new Error(`unexpected request ${route}`)
      return new Response(await readFile(join(import.meta.dirname, "fixtures/host-api", fixture), "utf8"), { headers: { "content-type": "application/json" } })
    }
    const env: Record<Host, NodeJS.ProcessEnv> = {
      cloudflare: { CLOUDFLARE_ACCOUNT_ID: cloudflareAccount, CLOUDFLARE_API_TOKEN: token },
      deno: {},
      netlify: { NETLIFY_AUTH_TOKEN: token },
      node: {},
      vercel: { VERCEL_TEAM_ID: "team_a1b2c3d4e5f6g7h8i9j0", VERCEL_TOKEN: token },
    }

    const linked = await runSetup<SetupLinkResult & { error?: SetupError }>(["link", "--json"], root, env[form.host], { fetch: fakeFetch })
    expect(linked.stdout).not.toContain(token)
    if (form.host === "node") {
      expect(linked.exitCode).toBe(3)
      expect(linked.json.error?.code).toBe("SETUP_LINK_HOST_UNSUPPORTED")
      expect(existsSync(join(root, ".vitehub/link.json"))).toBe(false)
    }
    else {
      expect(linked.exitCode, JSON.stringify(linked.json.error)).toBe(0)
      expect(linked.json.link).toMatchObject({ host: form.host, project: { name: "my-app" }, verified: form.host !== "deno" })
      expect(requests).toHaveLength(form.host === "deno" ? 0 : 1)
      const file = await readFile(join(root, ".vitehub/link.json"), "utf8")
      expect(file).not.toContain(token)
      const status = (await runSetup<SetupStatus & { link: unknown }>(["status", "--json"], root, env[form.host])).json
      expect(status.link).toMatchObject({ host: form.host, project: { name: "my-app" } })
    }

    const unlinked = await runSetup<{ removed: boolean }>(["unlink", "--json"], root)
    expect(unlinked.exitCode).toBe(0)
    expect(unlinked.json.removed).toBe(form.host !== "node")
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(false)
    expect((await runSetup<{ removed: boolean }>(["unlink", "--json"], root)).json.removed).toBe(false)
  })
})
