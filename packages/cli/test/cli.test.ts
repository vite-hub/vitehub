import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-cli-provision-"))
  directories.push(rootDir)
  return rootDir
}

function provisionPlugin(apply: () => Promise<{ ids?: unknown }>) {
  return {
    vitehub: {
      cli: {
        namespaces: [],
        provision: [{
          id: "test:cloudflare",
          provider: "cloudflare",
          plan: async () => [{ kind: "test-resource", name: "demo", exists: false, apply }],
        }],
      },
    },
  }
}

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

describe("ViteHub CLI", () => {
  it("routes package-contributed CLI features", async () => {
    const stdout = stream()
    const stderr = stream()
    const run = vi.fn(() => 0)

    const exitCode = await runViteHubCli({
      args: ["agent", "eval", "support"],
      cwd: "/repo",
      loadConfig: async () => ({
        plugins: [{
          vitehub: {
            cli: {
              namespaces: [{
                features: [{ name: "eval", run }],
                name: "agent",
              }],
            },
          },
        }],
        root: "/repo",
      }) as never,
      stderr,
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(run).toHaveBeenCalledWith(["support"], expect.objectContaining({ rootDir: "/repo" }))
    expect(stderr.output()).toBe("")
  })

  it("prints namespace help", async () => {
    const stdout = stream()
    const exitCode = await runViteHubCli({
      args: ["agent"],
      loadConfig: async () => ({
        plugins: [{
          vitehub: {
            cli: {
              namespaces: [{
                description: "Agent development workflows.",
                features: [{ description: "Run ViteHub Agent Evals.", name: "eval", run: () => undefined }],
                name: "agent",
              }],
            },
          },
        }],
        root: "/repo",
      }) as never,
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toContain("Usage: vitehub agent <feature>")
    expect(stdout.output()).toContain("eval")
  })

  it("routes feature help to the package feature", async () => {
    const run = vi.fn(() => 0)
    const exitCode = await runViteHubCli({
      args: ["agent", "eval", "--help"],
      loadConfig: async () => ({
        plugins: [{
          vitehub: {
            cli: {
              namespaces: [{
                features: [{ name: "eval", run }],
                name: "agent",
              }],
            },
          },
        }],
        root: "/repo",
      }) as never,
    })

    expect(exitCode).toBe(0)
    expect(run).toHaveBeenCalledWith(["--help"], expect.objectContaining({ rootDir: "/repo" }))
  })

  it("returns one for unknown namespaces", async () => {
    const stderr = stream()
    const exitCode = await runViteHubCli({
      args: ["kv", "list"],
      loadConfig: async () => ({ plugins: [], root: "/repo" }) as never,
      stderr,
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("Unknown ViteHub CLI namespace: kv")
  })

  it("requires a provider for provision", async () => {
    const stderr = stream()
    const exitCode = await runViteHubCli({
      args: ["provision", "run"],
      loadConfig: async () => ({ plugins: [], root: "/repo" }) as never,
      stderr,
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("--provider cloudflare|vercel")
  })

  it("dry-run prints the create-if-absent plan without applying", async () => {
    const rootDir = await createTempDir()
    const apply = vi.fn(async () => ({ ids: { cloudflare: { test: { demo: "id" } } } }))
    const stdout = stream()

    const exitCode = await runViteHubCli({
      args: ["provision", "run", "--provider", "cloudflare", "--dry-run"],
      cwd: rootDir,
      loadConfig: async () => ({ plugins: [provisionPlugin(apply)], root: rootDir }) as never,
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(apply).not.toHaveBeenCalled()
    expect(stdout.output()).toContain("create\ttest-resource\tdemo")
  })

  it("collects provision steps installed by Nuxt modules", async () => {
    const rootDir = await createTempDir()
    const apply = vi.fn(async () => ({ ids: { cloudflare: { test: { demo: "id" } } } }))
    const stdout = stream()

    const exitCode = await runViteHubCli({
      args: ["provision", "run", "--provider", "cloudflare", "--dry-run"],
      cwd: rootDir,
      loadConfig: async () => ({ plugins: [], root: rootDir }) as never,
      loadNuxtVitePlugins: async () => [provisionPlugin(apply)],
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(apply).not.toHaveBeenCalled()
    expect(stdout.output()).toContain("create\ttest-resource\tdemo")
  })

  it("fails closed when provision credentials are missing", async () => {
    const rootDir = await createTempDir()
    const apply = vi.fn(async () => ({}))
    const stderr = stream()

    const exitCode = await runViteHubCli({
      args: ["provision", "run", "--provider", "cloudflare"],
      cwd: rootDir,
      env: {},
      loadConfig: async () => ({ plugins: [provisionPlugin(apply)], root: rootDir }) as never,
      stderr,
      stdout: stream(),
    })

    expect(exitCode).toBe(1)
    expect(apply).not.toHaveBeenCalled()
    expect(stderr.output()).toContain("CLOUDFLARE_ACCOUNT_ID")
  })

  it("applies provision steps and writes ids to provision state", async () => {
    const rootDir = await createTempDir()
    const apply = vi.fn(async () => ({ ids: { cloudflare: { test: { demo: "id-1" } } } }))

    const exitCode = await runViteHubCli({
      args: ["provision", "run", "--provider", "cloudflare"],
      cwd: rootDir,
      env: { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token" },
      loadConfig: async () => ({ plugins: [provisionPlugin(apply)], root: rootDir }) as never,
      stdout: stream(),
    })

    expect(exitCode).toBe(0)
    expect(apply).toHaveBeenCalledTimes(1)
    const raw = await readFile(join(rootDir, ".vitehub", "provision.json"), "utf8")
    expect(JSON.parse(raw)).toEqual({ cloudflare: { test: { demo: "id-1" } } })
  })
})
