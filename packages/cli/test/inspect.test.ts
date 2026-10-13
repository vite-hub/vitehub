import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { runViteHubCli } from "../src/index.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-cli-inspect-"))
  directories.push(rootDir)
  return rootDir
}

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
    },
  }
}

function inspectPlugins(rootDir: string) {
  return [
    {
      name: "queue",
      vitehub: {
        inspect: () => ({
          definitions: [{
            kind: "queue",
            label: "Queues",
            list: () => [{ fields: [{ label: "Kind", value: "Queue" }], file: "server/queues/email.ts", name: "email", source: "server-queue" }],
          }],
        }),
      },
    },
    {
      name: "rate-limit",
      vitehub: {
        inspect: {
          definitions: [{
            kind: "rate-limit",
            label: "Rate Limits",
            list: async () => [{ fields: [{ label: "Api token", value: "secret-token-value" }], file: "server/api/login.ts", name: "login", source: "require-rate-limit" }],
          }],
          providerOutput: [
            { description: "Rate Limit manifest", owner: "rate-limit", path: join(rootDir, ".vitehub/rate-limit/manifest.json") },
            { description: "Generated Cloudflare Worker config", owner: "vite-hub", path: join(rootDir, "dist/server/wrangler.json") },
          ],
        },
      },
    },
  ]
}

async function run(rootDir: string, args: string[]) {
  const stdout = stream()
  const stderr = stream()
  const exitCode = await runViteHubCli({
    args,
    cwd: rootDir,
    loadConfig: async () => ({ plugins: inspectPlugins(rootDir), root: rootDir }),
    loadNuxtViteConfig: async () => undefined,
    stderr,
    stdout,
  })
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

describe("vitehub inspect", () => {
  it("lists the inspect namespace in root help", async () => {
    const rootDir = await createTempDir()
    const result = await run(rootDir, ["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("inspect")
    expect(result.stdout).toContain("Inspect discovered Definitions and generated Provider Output.")
  })

  it("prints every contributed Definition kind in human output", async () => {
    const rootDir = await createTempDir()
    const result = await run(rootDir, ["inspect", "definitions"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Queues (queue): 1")
    expect(result.stdout).toContain("  email  server/queues/email.ts  [server-queue]")
    expect(result.stdout).toContain("    Kind: Queue")
    expect(result.stdout).toContain("Rate Limits (rate-limit): 1")
    expect(result.stdout).toContain("    Api token: [redacted]")
    expect(result.stdout).not.toContain("secret-token-value")
  })

  it.each([
    [["--kind", "queue"]],
    [["--kind=queue"]],
  ])("filters Definitions by kind (%j)", async (flags) => {
    const rootDir = await createTempDir()
    const result = await run(rootDir, ["inspect", "definitions", ...flags])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Queues (queue): 1")
    expect(result.stdout).not.toContain("Rate Limits")
  })

  it("rejects an unknown kind and lists the available kinds", async () => {
    const rootDir = await createTempDir()
    const result = await run(rootDir, ["inspect", "definitions", "--kind", "blob"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unknown Definition kind: blob")
    expect(result.stderr).toContain("Available kinds: queue, rate-limit")
  })

  it("prints redacted JSON Definitions", async () => {
    const rootDir = await createTempDir()
    const result = await run(rootDir, ["inspect", "definitions", "--json"])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      definitions: [
        {
          definitions: [{ fields: [{ label: "Kind", value: "Queue" }], file: "server/queues/email.ts", name: "email", source: "server-queue" }],
          kind: "queue",
          label: "Queues",
        },
        {
          definitions: [{ fields: [{ label: "Api token", value: "[redacted]" }], file: "server/api/login.ts", name: "login", source: "require-rate-limit" }],
          kind: "rate-limit",
          label: "Rate Limits",
        },
      ],
    })
  })

  it("reports present and missing Provider Output", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, ".vitehub/rate-limit"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/rate-limit/manifest.json"), JSON.stringify({ ids: ["login"] }))
    const result = await run(rootDir, ["inspect", "provider-output"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Provider Output: 1 of 3 present")
    expect(result.stdout).toContain("  .vitehub/rate-limit/manifest.json  (rate-limit) Rate Limit manifest")
    expect(result.stdout).toContain("Not generated:")
    expect(result.stdout).toContain("  .vitehub/provision.json  (cli)")
    expect(result.stdout).toContain("  dist/server/wrangler.json  (vite-hub)")
  })

  it("redacts secrets in Provider Output JSON content", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, "dist/server"), { recursive: true })
    await writeFile(join(rootDir, "dist/server/wrangler.json"), JSON.stringify({
      d1_databases: [{ binding: "DB", database_id: "db-id" }],
      name: "app",
      vars: { PUBLIC_FLAG: "on", STRIPE_KEY: "sk_live_value" },
    }))
    const result = await run(rootDir, ["inspect", "provider-output", "--json"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("sk_live_value")
    const parsed = JSON.parse(result.stdout)
    const wrangler = parsed.providerOutput.find((entry: { path: string }) => entry.path === "dist/server/wrangler.json")
    expect(wrangler).toMatchObject({
      content: {
        d1_databases: [{ binding: "DB", database_id: "db-id" }],
        name: "app",
        vars: { PUBLIC_FLAG: "[redacted]", STRIPE_KEY: "[redacted]" },
      },
      exists: true,
      owner: "vite-hub",
      type: "file",
    })
    expect(parsed.providerOutput.find((entry: { path: string }) => entry.path === ".vitehub/provision.json")).toMatchObject({ exists: false, owner: "cli" })
  })

  it("preserves provisioned resource names in Provider Output JSON", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), JSON.stringify({
      vercel: { blob: { api_key: "resource-id" } },
    }))
    const result = await run(rootDir, ["inspect", "provider-output", "--json"])

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.providerOutput.find((entry: { path: string }) => entry.path === ".vitehub/provision.json")).toMatchObject({
      content: { vercel: { blob: { api_key: "resource-id" } } },
      exists: true,
      owner: "cli",
    })
  })

  it("preserves the corruption diagnostic for malformed provision-state JSON", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub/provision.json"), "{invalid")
    const result = await run(rootDir, ["inspect", "provider-output", "--json"])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).providerOutput.find((entry: { path: string }) => entry.path === ".vitehub/provision.json")).toMatchObject({
      content: "[unreadable JSON]",
      exists: true,
      owner: "cli",
    })
  })

  it("rejects unknown arguments", async () => {
    const rootDir = await createTempDir()
    const result = await run(rootDir, ["inspect", "provider-output", "--kind", "queue"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unknown inspect argument: --kind")
  })
})
