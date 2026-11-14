import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"

import { describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"
import { buildOutput, builtProject, expectNoLeak, fakeHosts } from "./setup-deploy-helpers.ts"
import { runSetup } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { HostCliRun } from "@vite-hub/internal/host-credentials"
import type { ProvisionContext, ProvisionStep } from "@vite-hub/internal/provision"
import type { SetupDeployOutput, SetupError } from "../src/setup/index.ts"

type DeployJson = SetupDeployOutput & { error?: SetupError, rerun?: string }

const cloudflareEnv = { CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "cf-token-1" }
const migratingDeploy = "npx wrangler d1 migrations apply DB --remote --config ./server/wrangler.json && npx wrangler deploy --config ./server/wrangler.json"

/** A fake Cloudflare account with D1 databases, and a Provision Step that reads and creates them as the D1 step does. */
function fakeD1(events: string[] = []) {
  const databases = new Map<string, string>()
  const contexts: ProvisionContext[] = []
  const step: ProvisionStep = {
    id: "database:cloudflare-d1",
    provider: "cloudflare",
    recordedState: () => [{ category: "d1", declared: ["DB"], deleteHint: () => "" }],
    async plan(context) {
      contexts.push(context)
      if (!context.env.CLOUDFLARE_API_TOKEN || !context.env.CLOUDFLARE_ACCOUNT_ID) {
        context.logger.warn("database: skipping Cloudflare D1, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
        context.markPlanUnchecked?.()
        return []
      }
      const existing = databases.get("my-app-db")
      return [{
        kind: "cloudflare-d1",
        name: "my-app-db",
        exists: existing !== undefined,
        apply: async () => {
          let id = existing
          if (id === undefined) {
            id = `d1-${databases.size + 1}`
            databases.set("my-app-db", id)
            events.push("provision")
          }
          return { ids: { cloudflare: { d1: { DB: id } } } }
        },
      }]
    },
  }
  return { contexts, databases, step }
}

/** A build that records its turn and whether the ids were there for it to bind. */
function fakeBuild(root: string, events: string[]): ViteHubCliSpawn {
  return async (command, args) => {
    expect([command, ...args]).toEqual(["pnpm", "run", "build"])
    events.push(existsSync(join(root, ".vitehub/provision.json")) ? "build with ids" : "build without ids")
    return { exitCode: 0 }
  }
}

function wranglerLogin(accounts: Array<{ id: string, name: string }>): HostCliRun {
  return async (_command, args) => {
    if (args.includes("auth")) return { exitCode: 0, stdout: JSON.stringify({ token: "wrangler-login-token", type: "oauth" }) }
    if (args.includes("whoami")) return { exitCode: 0, stdout: JSON.stringify({ accounts, loggedIn: true }) }
    return { exitCode: 1, stdout: "" }
  }
}

async function readState(root: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ".vitehub/provision.json"), "utf8"))
}

describe("vitehub deploy provisions the host", () => {
  it("creates the missing resources, then builds, migrates, and deploys", async () => {
    const root = await builtProject("cloudflare", buildOutput("cloudflare", migratingDeploy))
    const hosts = await fakeHosts(cloudflareEnv)
    const events: string[] = []
    const d1 = fakeD1(events)
    const provisionSteps = vi.fn(() => [d1.step])
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, { provisionSteps, spawn: fakeBuild(root, events) })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(provisionSteps).toHaveBeenCalledOnce()
    expect(events).toEqual(["provision", "build with ids"])
    expect((await hosts.calls()).map(call => call.argv.slice(0, 2))).toEqual([["d1", "migrations"], ["deploy", "--config"]])
    expect(result.json.provision).toEqual({
      changed: [{ kind: "cloudflare-d1", name: "my-app-db", status: "create", step: "database:cloudflare-d1" }],
      ids: { d1: { DB: "d1-1" } },
    })
    expect(await readState(root)).toEqual({ cloudflare: { d1: { DB: "d1-1" } } })
  })

  it("creates nothing on the second deploy", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const events: string[] = []
    const d1 = fakeD1(events)
    const options = { provisionSteps: () => [d1.step], spawn: fakeBuild(root, events) }
    expect((await runSetup(["deploy", "--yes", "--json"], root, hosts.env, options)).exitCode).toBe(0)
    const state = await readFile(join(root, ".vitehub/provision.json"), "utf8")

    const second = await runSetup<DeployJson>(["deploy", "--yes"], root, hosts.env, options)
    expect(second.exitCode, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).not.toContain("Provision on")
    expect(d1.databases.size).toBe(1)
    expect(events).toEqual(["provision", "build with ids", "build with ids"])
    expect(await readFile(join(root, ".vitehub/provision.json"), "utf8")).toBe(state)
    expect((await hosts.state()).deploys).toBe(2)

    const json = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, options)
    expect(json.json.provision).toEqual({ changed: [], ids: { d1: { DB: "d1-1" } } })
  })

  it("prints what it creates", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await runSetup(["deploy", "--yes"], root, hosts.env, { provisionSteps: () => [fakeD1().step], spawn: fakeBuild(root, []) })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain("Provision on cloudflare:\ncreate\tcloudflare-d1\tmy-app-db\n")
    expect(result.stdout).toContain("Provisioned 1 resource on cloudflare. Ids are in .vitehub/provision.json.\n")
  })

  it("skips provision with --no-provision", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const provisionSteps = vi.fn(() => [fakeD1().step])
    const result = await runSetup<DeployJson>(["deploy", "--no-provision", "--yes", "--json"], root, hosts.env, { provisionSteps, spawn: fakeBuild(root, []) })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(provisionSteps).not.toHaveBeenCalled()
    expect(result.json.provision).toBeUndefined()
    expect(existsSync(join(root, ".vitehub/provision.json"))).toBe(false)
    expect((await hosts.state()).deploys).toBe(1)
  })

  it("gives provision the token and account of a wrangler login", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts()
    const d1 = fakeD1()
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, {
      provisionSteps: () => [d1.step],
      runHostCli: wranglerLogin([{ id: "acc-login", name: "Mine" }]),
      spawn: fakeBuild(root, []),
    })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(d1.contexts.map(context => [context.env.CLOUDFLARE_API_TOKEN, context.env.CLOUDFLARE_ACCOUNT_ID])).toEqual([["wrangler-login-token", "acc-login"]])
    expect(result.json.provision?.ids).toEqual({ d1: { DB: "d1-1" } })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, ["wrangler-login-token"])
  })

  it("takes the account of the link when the wrangler login has several", async () => {
    const link = { default: "cloudflare", schemaVersion: 2, targets: { cloudflare: { account: { id: "acc-linked" }, linkedAt: "", project: { name: "my-app" }, verified: true } } }
    const root = await builtProject("cloudflare", { ".vitehub/link.json": JSON.stringify(link) })
    const hosts = await fakeHosts()
    const d1 = fakeD1()
    const runHostCli = wranglerLogin([{ id: "acc-a", name: "A" }, { id: "acc-b", name: "B" }])
    const result = await runSetup(["deploy", "--yes", "--json"], root, hosts.env, { provisionSteps: () => [d1.step], runHostCli, spawn: fakeBuild(root, []) })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(d1.contexts[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe("acc-linked")
  })

  it("fails before any deploy write when the login cannot provision", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts()
    const events: string[] = []
    const d1 = fakeD1(events)
    const runHostCli = wranglerLogin([{ id: "acc-a", name: "A" }, { id: "acc-b", name: "B" }])
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, { provisionSteps: () => [d1.step], runHostCli, spawn: fakeBuild(root, events) })

    expect(result.exitCode).toBe(2)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_PROVISION_UNCHECKED")
    expect(result.json.error?.fix).toContain("Set CLOUDFLARE_ACCOUNT_ID, or run `vitehub link --host cloudflare --account <id>`.")
    expect(result.json.rerun).toBe("vitehub deploy --no-provision --yes --json")
    expect(events).toEqual([])
    expect(await hosts.calls()).toEqual([])
    expect(existsSync(join(root, ".vitehub/provision.json"))).toBe(false)
  })

  it("asks for VERCEL_TOKEN when only a vercel login is saved", async () => {
    const root = await builtProject("vercel")
    const hosts = await fakeHosts()
    const blob: ProvisionStep = {
      id: "blob:vercel-blob",
      provider: "vercel",
      async plan(context) {
        if (!context.env.VERCEL_TOKEN) {
          context.logger.warn("blob: skipping Vercel Blob, missing VERCEL_TOKEN/VERCEL_PROJECT_ID.")
          context.markPlanUnchecked?.()
        }
        return []
      },
    }
    const runHostCli: HostCliRun = async () => ({ exitCode: 0, stdout: "saved-user\n" })
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, { provisionSteps: () => [blob], runHostCli, spawn: fakeBuild(root, []) })

    expect(result.exitCode).toBe(2)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_PROVISION_UNCHECKED")
    expect(result.json.error?.fix).toContain("A saved `vercel login` cannot create Vercel resources. Set VERCEL_TOKEN")
    expect(await hosts.calls()).toEqual([])
  })

  it("does not create resources for an output built without their ids", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const d1 = fakeD1()
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--yes", "--json"], root, hosts.env, { provisionSteps: () => [d1.step] })

    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_PROVISION_NEEDS_BUILD")
    expect(d1.databases.size).toBe(0)
    expect(await hosts.calls()).toEqual([])
  })

  it("loads the Provision Steps of a build for the deploy host", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const d1 = fakeD1()
    const hostsSeen: Array<[string | undefined, string | undefined, string]> = []
    const loadConfig = vi.fn(async (_root: string, command: "build" | "serve") => {
      hostsSeen.push([process.env.VITEHUB_HOST, process.env.VITEHUB_HOST_SOURCE, command])
      return { plugins: [{ vitehub: { cli: { namespaces: [], provision: [d1.step] } } }], root, vitehubConfigResolved: true as const }
    })
    let stdout = ""
    const exitCode = await runViteHubCli({
      args: ["deploy", "--host", "cloudflare", "--yes", "--json"],
      cwd: root,
      env: hosts.env,
      loadConfig,
      spawn: fakeBuild(root, []),
      stderr: { write: () => true },
      stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk) } },
    })

    expect(exitCode, stdout).toBe(0)
    expect(hostsSeen).toEqual([["cloudflare", "cli", "build"]])
    expect((JSON.parse(stdout) as DeployJson).provision?.ids).toEqual({ d1: { DB: "d1-1" } })
  })
})
