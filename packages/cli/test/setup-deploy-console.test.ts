import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { consoleEnv, consoleToken, consoleUrl, fakeConsole } from "./fake-console.ts"
import { builtProject, fakeHosts } from "./setup-deploy-helpers.ts"
import { runSetup } from "./setup-helpers.ts"

import type { SetupDeployOutput, SetupError } from "../src/setup/index.ts"

type DeployJson = SetupDeployOutput & { error?: SetupError }
type Host = "cloudflare" | "vercel" | "deno"

const keyName = "VITEHUB_CONSOLE_KEY_CONSOLE_A1B2C3D4"
const consoleKey = { names: [], prefix: "VITEHUB_CONSOLE_KEY_", required: true, secret: false, hasDefault: false, owners: ["console"] }
const hostEnv: Record<Host, NodeJS.ProcessEnv> = {
  cloudflare: { CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "cf-token-1" },
  vercel: { VERCEL_TEAM_ID: "team_1", VERCEL_TOKEN: "vercel-token-1" },
  deno: { DENO_DEPLOY_ORG: "my-org", DENO_DEPLOY_TOKEN: "deno-token-1" },
}
const outputDirs: Record<Host, string> = { cloudflare: ".output", vercel: ".vercel/output", deno: ".output" }
const vercelLink = { account: { id: "team_1" }, project: { id: "prj_1", name: "my-app" }, verified: true, linkedAt: "" }

async function project(host: Host, options: { linked?: boolean } = {}): Promise<string> {
  return await builtProject(host, {
    [`${outputDirs[host]}/deployment.json`]: JSON.stringify({ env: [consoleKey], host, identity: { name: "my-app", source: "package" } }),
    ".gitignore": ".output\n.vercel\n.vitehub\n.env*\n",
    ...(options.linked ? { ".vitehub/link.json": JSON.stringify({ default: host, schemaVersion: 2, targets: { [host]: vercelLink } }) } : {}),
  })
}

function deploy(args: string[], root: string, env: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch) {
  return runSetup<DeployJson>(["deploy", "--no-build", "--yes", ...args, "--json"], root, env, fetch ? { fetch } : {})
}

describe("vitehub deploy links the app in the Console", () => {
  it("on Cloudflare links the first deploy, sets the key, and re-supplies the key of the Console on the next deploy", async () => {
    const root = await project("cloudflare")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const console = fakeConsole({ appKnowsKey: true })
    const env = { ...hosts.env, ...consoleEnv(root) }

    const first = await deploy([], root, env, console.fetch)
    expect(first.exitCode, first.stderr).toBe(0)
    expect(first.json).not.toHaveProperty("version")
    expect(first.json.console).toEqual({ app: "a1b2c3d4-0", console: consoleUrl, created: true, keySet: keyName, linked: true, url: `${consoleUrl}/open?project=${encodeURIComponent("https://my-app.example.workers.dev")}` })
    expect((await hosts.calls()).map(call => call.argv.slice(0, 3))).toEqual([["deploy", "--config", "./server/wrangler.json"], ["secret", "put", keyName]])
    expect((await hosts.state()).secrets).toEqual({ [keyName]: "pk" })
    expect(console.requests.map(request => `${request.method} ${request.path}`)).toEqual(["GET /api/projects", "POST /api/projects", "POST /api/projects/a1b2c3d4-0/check"])
    expect(console.requests[1]!.body).toEqual({ label: "my-app", url: "https://my-app.example.workers.dev" })
    expect(first.stdout + first.stderr).not.toContain(consoleToken)

    const second = await deploy([], root, env, console.fetch)
    expect(second.exitCode, second.stderr).toBe(0)
    expect(second.json.console).toMatchObject({ app: "a1b2c3d4-0", created: false, linked: true })
    expect(second.json.console).not.toHaveProperty("keySet")
    expect(second.stderr).toContain(`Setting ${keyName} on cloudflare with the new version from the Console, replaced.`)
    expect((await hosts.calls()).at(-1)?.secretsFile?.values).toEqual({ [keyName]: "pk" })
    expect(console.apps).toHaveLength(1)
    expect(console.requests.filter(request => request.method === "POST" && request.path === "/api/projects")).toHaveLength(1)

    await writeFile(join(root, ".output/server/wrangler.json"), JSON.stringify({ name: "my-app", routes: [{ pattern: "app.example.com", custom_domain: true }] }))
    const requests = console.requests.length
    const moved = await deploy([], root, env, console.fetch)
    expect(moved.exitCode, moved.stderr).toBe(0)
    expect(moved.json.console).toBeUndefined()
    expect(moved.stderr).toContain("not https://app.example.com")
    expect(console.requests.slice(requests).map(request => request.method)).toEqual(["GET"])

    const down: typeof fetch = async () => Response.json({ code: "CONSOLE_DOWN", message: "Down." }, { status: 503 })
    const blocked = await deploy([], root, env, down)
    expect(blocked.json.error).toMatchObject({ code: "SETUP_DEPLOY_ENV_STAGE_UNSAFE", fix: expect.stringContaining("copy the public value of the existing link") })
    const fallback = await deploy([], root, { ...env, [keyName]: "pk" }, down)
    expect(fallback.exitCode, fallback.stderr).toBe(0)
    expect((await hosts.calls()).at(-1)?.secretsFile?.values).toEqual({ [keyName]: "pk" })
  })

  it("on Vercel sets the key and deploys again so the app reads it", async () => {
    const root = await project("vercel", { linked: true })
    const hosts = await fakeHosts(hostEnv.vercel)
    const console = fakeConsole({ appKnowsKey: true })

    const deployed = await deploy([], root, { ...hosts.env, ...consoleEnv(root) }, console.fetch)
    expect(deployed.exitCode, deployed.stdout + deployed.stderr).toBe(0)
    expect(deployed.json.deploymentId).toBe("dpl_2")
    expect(deployed.json.console).toMatchObject({ created: true, keySet: keyName, linked: true, url: `${consoleUrl}/open?project=${encodeURIComponent("https://my-app.vercel.app")}` })
    expect(deployed.stderr).toContain(`Deploying again, so vercel reads ${keyName}.`)
    const state = await hosts.state() as { deploys: number, vercel?: Record<string, Record<string, string>> }
    expect(state.deploys).toBe(2)
    expect(state.vercel?.production).toEqual({ [keyName]: "pk" })
  })

  it("does not link an immutable Vercel URL without a production alias", async () => {
    const root = await project("vercel", { linked: true })
    const hosts = await fakeHosts({ ...hostEnv.vercel, FAKE_VERCEL_NO_ALIAS: "1" })
    const console = fakeConsole()
    const deployed = await deploy([], root, { ...hosts.env, ...consoleEnv(root) }, console.fetch)
    expect(deployed.exitCode, deployed.stderr).toBe(0)
    expect(deployed.json.console).toBeUndefined()
    expect(console.requests.map(request => request.method)).toEqual(["GET"])
  })

  it("installs the public key on Deno and deploys again", async () => {
    const root = await project("deno")
    const hosts = await fakeHosts(hostEnv.deno)
    const console = fakeConsole({ appKnowsKey: true })
    const deployed = await deploy([], root, { ...hosts.env, ...consoleEnv(root) }, console.fetch)
    expect(deployed.exitCode, deployed.stderr).toBe(0)
    expect(deployed.json.console).toMatchObject({ created: true, keySet: keyName, linked: true })
    expect((await hosts.state()).deploys).toBe(2)
    expect((await hosts.calls()).find(call => call.argv.includes("--non-secrets"))?.argv).toContain(keyName)
  })

  it("also writes explicit public keys with --push-env", async () => {
    const root = await project("vercel", { linked: true })
    const hosts = await fakeHosts(hostEnv.vercel)
    const console = fakeConsole({ appKnowsKey: true })
    const env = { ...hosts.env, ...consoleEnv(root) }
    const first = await deploy([], root, { ...env, VITEHUB_CONSOLE_KEY_CI: "first" }, console.fetch)
    expect(first.json.env.pushed).toContain("VITEHUB_CONSOLE_KEY_CI")
    const second = await deploy(["--push-env"], root, { ...env, VITEHUB_CONSOLE_KEY_CI: "updated" }, console.fetch)
    expect(second.json.env.pushed).toEqual(["VITEHUB_CONSOLE_KEY_CI"])
    expect((await hosts.calls()).filter(call => call.argv.includes("VITEHUB_CONSOLE_KEY_CI")).map(call => call.stdin)).toEqual(["first", "updated"])
  })

  it("without a login or with --no-console needs the key like any other name, and says how to get it", async () => {
    const root = await project("cloudflare")
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const signedOut = await deploy([], root, { ...hosts.env, XDG_CONFIG_HOME: root })
    expect(signedOut.exitCode).toBe(2)
    expect(signedOut.json.error).toMatchObject({ code: "SETUP_DEPLOY_ENV_MISSING", fix: expect.stringContaining("run `vitehub login`") })

    const console = fakeConsole()
    const skipped = await deploy(["--no-console"], root, { ...hosts.env, ...consoleEnv(root) }, console.fetch)
    expect(skipped.json.error?.code).toBe("SETUP_DEPLOY_ENV_MISSING")
    expect(console.requests).toEqual([])
    expect(await hosts.calls()).toEqual([])
  })

  it("deploys when the Console fails, and says how to link later", async () => {
    const root = await project("cloudflare")
    const hosts = await fakeHosts({ ...hostEnv.cloudflare, VITEHUB_CONSOLE_KEY_LOCAL: "pk-local" })
    const failing = (async () => Response.json({ code: "CONSOLE_DOWN", message: "Down." }, { status: 503 })) as typeof globalThis.fetch
    const deployed = await deploy([], root, { ...hosts.env, ...consoleEnv(root) }, failing)
    expect(deployed.exitCode, deployed.stderr).toBe(0)
    expect(deployed.json.console).toBeUndefined()
    expect(deployed.stderr).toContain("Warning: deploy does not link the app in the Console, because the Console failed:")
  })
})
