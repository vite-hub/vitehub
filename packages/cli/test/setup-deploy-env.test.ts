import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { describe, expect, it } from "vitest"

import { buildOutput, builtProject, expectNoLeak, fakeHosts } from "./setup-deploy-helpers.ts"
import { runSetup } from "./setup-helpers.ts"

import type { SetupDeployOutput, SetupError, SetupMissing } from "../src/setup/index.ts"

type DeployJson = SetupDeployOutput & { error?: SetupError, missing?: SetupMissing[], rerun?: string }
type Host = "cloudflare" | "vercel"

/** A value that must reach the host only on stdin or in the secrets file, never in argv or output. */
const canary = "canary-5e1d9b7c3a"
const previewCanary = "preview-canary-8b2f4d"
const tokens = ["cf-token-1", "vercel-token-1"]
const hostEnv: Record<Host, NodeJS.ProcessEnv> = {
  cloudflare: { CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "cf-token-1" },
  vercel: { VERCEL_TEAM_ID: "team_1", VERCEL_TOKEN: "vercel-token-1" },
}
const outputDirs: Record<Host, string> = { cloudflare: ".output", vercel: ".vercel/output" }
const links = {
  cloudflare: { account: { id: "acc-1" }, project: { name: "my-app" }, verified: true, linkedAt: "" },
  vercel: { account: { id: "team_1" }, project: { id: "prj_1", name: "my-app" }, verified: true, linkedAt: "" },
}

const apiKey = { path: "env.server.apiKey", names: ["API_KEY"], required: true, secret: true, hasDefault: false }
const sentry = { path: "env.server.sentryDsn", names: ["SENTRY_DSN"], required: false, secret: false, hasDefault: false }
const appSecret = { names: ["VITEHUB_SECRET"], required: true, secret: true, hasDefault: false, owners: ["vite-hub"] }

/** A built project whose `deployment.json` lists `env`. `linked` writes a link target for the host. */
async function project(host: Host, env: readonly object[], options: { linked?: boolean, deployCommand?: string, files?: Record<string, string> } = {}): Promise<string> {
  return await builtProject(host, {
    ...(options.deployCommand ? buildOutput(host, options.deployCommand) : {}),
    [`${outputDirs[host]}/deployment.json`]: JSON.stringify({ env, host, identity: { name: "my-app", source: "package" } }),
    ".gitignore": ".output\n.vercel\n.vitehub\n.env*\n",
    ...(options.linked === false ? {} : { ".vitehub/link.json": JSON.stringify({ default: host, schemaVersion: 2, targets: { [host]: links[host] } }) }),
    ...options.files,
  })
}

/** Seeds the fake host state, as if the dashboard or an earlier push set the values. */
async function seed(env: NodeJS.ProcessEnv, state: object): Promise<void> {
  await writeFile(env.FAKE_HOST_STATE!, JSON.stringify({ deploys: 0, secrets: {}, ...state }))
}

function deploy(args: string[], root: string, env: NodeJS.ProcessEnv) {
  return runSetup<DeployJson>(["deploy", "--no-build", "--yes", ...args, "--json"], root, env)
}

describe("vitehub deploy checks Server Env", () => {
  const migratingDeploy = "npx wrangler d1 migrations apply DB --remote --config ./server/wrangler.json && npx wrangler deploy --config ./server/wrangler.json"

  it("fails before any host write when a required name is on neither the host nor a local value", async () => {
    const root = await project("cloudflare", [apiKey, sentry], { deployCommand: migratingDeploy })
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await deploy([], root, hosts.env)

    expect(result.exitCode).toBe(2)
    expect(result.json.error).toMatchObject({ code: "SETUP_DEPLOY_ENV_MISSING", fix: expect.stringContaining("vitehub env push --host cloudflare") })
    expect(result.json.error?.why).toContain("API_KEY (env.server.apiKey)")
    expect(result.json.missing).toEqual([{ field: "API_KEY" }])
    // Only the read of the host names ran: no D1 migration, no deploy, no secret.
    expect((await hosts.calls()).map(call => call.argv.slice(0, 2))).toEqual([["secret", "list"]])
    expect(await hosts.state()).toMatchObject({ deploys: 0, secrets: {} })

    const vercelRoot = await project("vercel", [apiKey])
    const vercel = await fakeHosts(hostEnv.vercel)
    const failed = await deploy([], vercelRoot, vercel.env)
    expect(failed.json.error?.code).toBe("SETUP_DEPLOY_ENV_MISSING")
    expect((await vercel.calls()).map(call => call.argv.slice(0, 2))).toEqual([["env", "ls"]])
  })

  it("deploys when the host has every required name, and warns once for a missing optional name", async () => {
    const root = await project("cloudflare", [apiKey, sentry])
    const hosts = await fakeHosts(hostEnv.cloudflare)
    await seed(hosts.env, { secrets: { API_KEY: "x" } })
    const result = await deploy([], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.json.env).toEqual({ checked: ["API_KEY", "SENTRY_DSN"], missing: [{ names: ["SENTRY_DSN"], path: "env.server.sentryDsn", secret: false }], pushed: [], stage: "production" })
    expect(result.stderr.split("\n").filter(line => line.startsWith("Warning:"))).toEqual(["Warning: optional env not set on cloudflare: SENTRY_DSN (env.server.sentryDsn)."])
    // Nothing to upload, so no secrets file.
    expect((await hosts.calls()).map(call => call.argv)).toEqual([
      ["secret", "list", "--format", "json", "--name", "my-app"],
      ["deploy", "--config", "./server/wrangler.json", "--name", "my-app"],
    ])
  })

  it("uploads local values to Cloudflare with the version in a JSON secrets file that is mode 600 and removed after", async () => {
    const root = await project("cloudflare", [apiKey, sentry], {
      files: { ".env.production": `API_KEY=${canary}\nSENTRY_DSN=https://sentry.example\n`, ".env.preview": `API_KEY=${previewCanary}\n` },
    })
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await deploy([], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.map(call => call.argv.slice(0, 2))).toEqual([["secret", "list"], ["deploy", "--config"]])
    const call = calls[1]!
    const file = call.argv[call.argv.indexOf("--secrets-file") + 1]!
    expect(call.secretsFile).toEqual({ mode: 0o600, path: file, values: { API_KEY: canary, SENTRY_DSN: "https://sentry.example" } })
    expect(file.endsWith(".json")).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(dirname(file))).toBe(false)
    // No `secret put`: the values arrive with the new version only.
    expect(calls.some(item => item.argv[1] === "put")).toBe(false)
    expect(result.json.env).toMatchObject({ missing: [], pushed: ["API_KEY", "SENTRY_DSN"], stage: "production" })
    expectNoLeak(calls, result.stdout + result.stderr, [...tokens, canary, previewCanary])
    expect(result.stderr).toContain("Setting API_KEY on cloudflare with the new version from .env.production.")
  })

  it("uploads the preview stage with `wrangler versions upload` and leaves production values alone", async () => {
    const root = await project("cloudflare", [apiKey], { files: { ".env.production": `API_KEY=${canary}\n`, ".env.preview": `API_KEY=${previewCanary}\n` } })
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await deploy(["--preview"], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    const call = (await hosts.calls())[1]!
    expect(call.argv.slice(0, 2)).toEqual(["versions", "upload"])
    const file = call.argv[call.argv.indexOf("--secrets-file") + 1]!
    expect(call.secretsFile).toEqual({ mode: 0o600, path: file, values: { API_KEY: previewCanary } })
    expect(existsSync(file)).toBe(false)
    expect(result.json.env).toMatchObject({ pushed: ["API_KEY"], stage: "preview" })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [canary, previewCanary])
  })

  it("sets missing names from local values, and --push-env also replaces names the host has, before the deploy", async () => {
    const root = await project("vercel", [apiKey, sentry], { files: { ".env.production": `API_KEY=${canary}\nSENTRY_DSN=https://sentry.example\n` } })
    const hosts = await fakeHosts(hostEnv.vercel)
    await seed(hosts.env, { vercel: { production: { API_KEY: "old" } } })
    const result = await deploy([], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    // API_KEY is on the host, so only the missing SENTRY_DSN is set.
    expect((await hosts.calls()).map(call => call.argv.slice(0, 3))).toEqual([["env", "ls", "--environment"], ["env", "add", "SENTRY_DSN"], ["deploy", "--prebuilt", "--yes"]])
    expect(result.json.env.pushed).toEqual(["SENTRY_DSN"])

    const replaced = await fakeHosts(hostEnv.vercel)
    await seed(replaced.env, { vercel: { production: { API_KEY: "old" } } })
    const pushed = await deploy(["--push-env"], root, replaced.env)

    expect(pushed.exitCode, pushed.stderr).toBe(0)
    const calls = await replaced.calls()
    expect(calls.map(call => [...call.argv.slice(0, 3), call.stdin])).toEqual([
      ["env", "ls", "--environment", ""],
      ["env", "add", "API_KEY", canary],
      ["env", "add", "SENTRY_DSN", "https://sentry.example"],
      ["deploy", "--prebuilt", "--yes", ""],
    ])
    expect(calls[1]!.argv).toContain("--sensitive")
    expect(pushed.json.env).toMatchObject({ pushed: ["API_KEY", "SENTRY_DSN"], stage: "production" })
    expect(pushed.stderr).toContain("Setting API_KEY on vercel from .env.production, replaced.")
    expectNoLeak(calls, pushed.stdout + pushed.stderr, [...tokens, canary])
    expect(JSON.stringify(pushed.json)).not.toContain(canary)
  })

  it("refuses a secret from an env file that git tracks, before any host write", async () => {
    const root = await project("vercel", [apiKey], { files: { ".env.production": `API_KEY=${canary}\n` } })
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["add", "-f", ".env.production"], { cwd: root })
    const hosts = await fakeHosts(hostEnv.vercel)
    const result = await deploy([], root, hosts.env)

    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_ENV_FILE_TRACKED")
    expect((await hosts.calls()).map(call => call.argv.slice(0, 2))).toEqual([["env", "ls"]])
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [canary])
  })

  it("generates a missing VITEHUB_SECRET with --yes, uploads it, and prints only that it was set", async () => {
    const root = await project("cloudflare", [appSecret])
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const result = await deploy([], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    const call = (await hosts.calls())[1]!
    const value = call.secretsFile?.values?.VITEHUB_SECRET ?? ""
    expect(Buffer.from(value, "base64")).toHaveLength(32)
    expect(result.json.env).toMatchObject({ generated: ["VITEHUB_SECRET"], pushed: ["VITEHUB_SECRET"] })
    expect(result.stderr).toContain("Generated VITEHUB_SECRET and set it on cloudflare.")
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, [value])
    expect(JSON.stringify(result.json)).not.toContain(value)
    expect((await hosts.state()).secrets.VITEHUB_SECRET).toBe(value)

    // A VITEHUB_SECRET on the host stays as it is.
    const kept = await fakeHosts(hostEnv.cloudflare)
    await seed(kept.env, { secrets: { VITEHUB_SECRET: "x" } })
    const second = await deploy([], root, kept.env)
    expect(second.json.env).toMatchObject({ pushed: [] })
    expect(second.json.env.generated).toBeUndefined()
    expect((await kept.calls())[1]!.secretsFile).toBeUndefined()
  })

  it("on a first deploy reads no host names: Cloudflare needs every required value locally, other hosts need a link", async () => {
    const root = await project("cloudflare", [apiKey], { linked: false })
    const hosts = await fakeHosts(hostEnv.cloudflare)
    const missing = await deploy([], root, hosts.env)

    expect(missing.exitCode).toBe(2)
    expect(missing.json.error?.code).toBe("SETUP_DEPLOY_ENV_MISSING")
    expect(missing.json.error?.why).toContain("This is the first deploy to cloudflare")
    expect(missing.json.error?.fix).toContain("vitehub link --host cloudflare")
    expect(await hosts.calls()).toEqual([])

    const withValue = await fakeHosts({ ...hostEnv.cloudflare, API_KEY: canary })
    const deployed = await deploy([], root, withValue.env)
    expect(deployed.exitCode, deployed.stderr).toBe(0)
    const calls = await withValue.calls()
    expect(calls.map(call => call.argv[0])).toEqual(["deploy"])
    expect(calls[0]!.secretsFile?.values).toEqual({ API_KEY: canary })
    expect(deployed.stderr).toContain("Setting API_KEY on cloudflare with the new version from the shell.")
    expectNoLeak(calls, deployed.stdout + deployed.stderr, [canary])

    const vercelRoot = await project("vercel", [apiKey], { linked: false, files: { ".env.production": `API_KEY=${canary}\n` } })
    const vercel = await fakeHosts(hostEnv.vercel)
    const unlinked = await deploy([], vercelRoot, vercel.env)
    expect(unlinked.exitCode).toBe(2)
    expect(unlinked.json.error?.code).toBe("SETUP_DEPLOY_ENV_NOT_LINKED")
    expect(unlinked.json.rerun).toBe("vitehub link --host vercel --create")
    expect(await vercel.calls()).toEqual([])
  })
})
