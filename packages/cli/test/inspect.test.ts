import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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
    expect(result.stdout).toContain("Inspect discovered Definitions, host resources, and generated Provider Output.")
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
      vercel: { blob: { api_key: "resource-id", invalid: 42, credentials: "https://user:secret@example.com/store" } },
    }))
    const result = await run(rootDir, ["inspect", "provider-output", "--json"])

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    const report = parsed.providerOutput.find((entry: { path: string }) => entry.path === ".vitehub/provision.json")
    expect(report).toMatchObject({ exists: true, owner: "cli" })
    expect(report.content).toEqual({
      vercel: { blob: { api_key: "resource-id", credentials: "[redacted]" } },
    })
    expect(result.stdout).not.toContain("user:secret")
  })

  it.each(["{invalid", ""])("preserves the corruption diagnostic for invalid provision-state JSON %j", async (raw) => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    const path = join(rootDir, ".vitehub/provision.json")
    await writeFile(path, raw)
    const result = await run(rootDir, ["inspect", "provider-output", "--json"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout).providerOutput.find((entry: { path: string }) => entry.path === ".vitehub/provision.json")).toMatchObject({
      content: "[unreadable JSON]",
      exists: true,
      owner: "cli",
    })
    expect(await readFile(path, "utf8")).toBe(raw)
  })

  it("reports a directory at the provision-state path without reading it as state", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, ".vitehub/provision.json"), { recursive: true })
    const result = await run(rootDir, ["inspect", "provider-output", "--json"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const report = JSON.parse(result.stdout).providerOutput.find((entry: { path: string }) => entry.path === ".vitehub/provision.json")
    expect(report).toMatchObject({ exists: true, owner: "cli", type: "directory" })
    expect(report).not.toHaveProperty("content")
  })

  it("rejects unknown arguments", async () => {
    const rootDir = await createTempDir()
    const result = await run(rootDir, ["inspect", "provider-output", "--kind", "queue"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unknown inspect argument: --kind")
  })
})

describe("vitehub inspect resources", () => {
  async function runResources(rootDir: string, args: string[], wranglerPath = join(rootDir, "dist/server/wrangler.json")) {
    const stdout = stream()
    const stderr = stream()
    const exitCode = await runViteHubCli({
      args: ["inspect", "resources", ...args],
      cwd: rootDir,
      loadConfig: async () => ({
        plugins: [{
          name: "resources",
          vitehub: {
            inspect: {
              providerOutput: [{ description: "Generated Cloudflare Worker config", owner: "vite-hub", path: wranglerPath }],
              resources: () => [
                { binding: "DB", definition: "default", host: "cloudflare", id: "db-state", kind: "cloudflare-d1", name: "app-db", owner: "database", source: "provision-state" },
                { binding: "KV", definition: "default", host: "cloudflare", kind: "cloudflare-kv-namespace", name: "app-cache", owner: "kv" },
                { binding: "BLOB", definition: "default", host: "cloudflare", kind: "cloudflare-r2-bucket", name: "uploads", owner: "blob", source: "name" },
                { definition: "media", host: "vercel", kind: "vercel-blob-store", note: "Vercel sets `BLOB_STORE_ID` for the store that is connected to the project. Off Vercel, set `BLOB_READ_WRITE_TOKEN`.", owner: "blob" },
              ],
            },
          },
        }],
        root: rootDir,
      }),
      loadNuxtViteConfig: async () => undefined,
      stderr,
      stdout,
    })
    return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
  }

  it("shows each resource with its id source and reads missing ids from generated Wrangler config", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, "dist/server"), { recursive: true })
    await writeFile(join(rootDir, "dist/server/wrangler.json"), JSON.stringify({
      d1_databases: [{ binding: "DB", database_id: "db-built", database_name: "app-db" }],
      kv_namespaces: [{ binding: "KV", id: "ns-built" }],
    }))

    const human = await runResources(rootDir, [])
    expect(human).toMatchObject({ exitCode: 0, stderr: "" })
    expect(human.stdout).toBe([
      "cloudflare\tcloudflare-d1\tdefault",
      "  Name: app-db",
      "  Binding: DB",
      "  Id: db-state",
      "  Source: .vitehub/provision.json",
      "cloudflare\tcloudflare-kv-namespace\tdefault",
      "  Name: app-cache",
      "  Binding: KV",
      "  Id: ns-built",
      "  Source: generated provider output",
      "cloudflare\tcloudflare-r2-bucket\tdefault",
      "  Name: uploads",
      "  Binding: BLOB",
      "  Source: bound by name",
      "vercel\tvercel-blob-store\tmedia",
      "  Source: none",
      "  Note: Vercel sets `BLOB_STORE_ID` for the store that is connected to the project. Off Vercel, set `BLOB_READ_WRITE_TOKEN`.",
      "",
    ].join("\n"))

    const json = await runResources(rootDir, ["--json"])
    expect(JSON.parse(json.stdout).resources.map(({ id, kind, source }: { id?: string, kind: string, source?: string }) => ({ id, kind, source }))).toEqual([
      { id: "db-state", kind: "cloudflare-d1", source: "provision-state" },
      { id: "ns-built", kind: "cloudflare-kv-namespace", source: "provider-output" },
      { kind: "cloudflare-r2-bucket", source: "name" },
      { kind: "vercel-blob-store" },
    ])
  })

  it("reads missing resource ids from a Wrangler path with Windows separators", async () => {
    const rootDir = await createTempDir()
    const wranglerPath = join(rootDir, "dist\\server\\wrangler.json")
    await mkdir(dirname(wranglerPath), { recursive: true })
    await writeFile(wranglerPath, JSON.stringify({ kv_namespaces: [{ binding: "KV", id: "windows-namespace" }] }))

    const result = await runResources(rootDir, ["--json"], wranglerPath)
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(JSON.parse(result.stdout).resources).toContainEqual(expect.objectContaining({
      binding: "KV", id: "windows-namespace", source: "provider-output",
    }))
  })

  it("reports when no Definition maps to a host resource", async () => {
    const rootDir = await createTempDir()
    const stdout = stream()
    await expect(runViteHubCli({
      args: ["inspect", "resources"],
      cwd: rootDir,
      loadConfig: async () => ({ plugins: [], root: rootDir }),
      loadNuxtViteConfig: async () => undefined,
      stdout,
    })).resolves.toBe(0)
    expect(stdout.output()).toBe("No Definition maps to a host resource.\n")
  })
})
