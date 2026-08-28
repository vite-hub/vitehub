import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import type { ViteHubCliContext } from "@vite-hub/internal/cli"

import { runViteHubCli, runViteHubCliEntrypoint } from "../src/index.ts"

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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
    },
  }
}

describe("ViteHub CLI", () => {
  it("flushes configured entrypoint streams before exiting", async () => {
    const callbacks: Array<() => void> = []
    const createStream = () => ({
      output: "",
      flush() {
        return new Promise<void>(resolve => callbacks.push(resolve))
      },
      write(chunk: string | Uint8Array, callback: () => void = () => {}) {
        this.output += String(chunk)
        callback()
        return true
      },
    })
    const stdout = createStream()
    const stderr = createStream()
    // SAFETY: The mock deliberately returns so tests can observe the requested exit status.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    runViteHubCliEntrypoint({
      args: ["--help"],
      loadConfig: async () => ({
        plugins: [],
        root: "/repo",
      }),
      stderr,
      stdout,
    })
    await vi.waitFor(() => expect(callbacks).toHaveLength(2))

    expect(stdout.output).toContain("Usage: vitehub")
    expect(exit).not.toHaveBeenCalled()
    callbacks.shift()!()
    expect(exit).not.toHaveBeenCalled()
    callbacks.shift()!()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it("exits unsuccessfully when a configured entrypoint stream fails to flush", async () => {
    const stdout = {
      flush: () => Promise.reject(new Error("flush failed")),
      write: vi.fn(),
    }
    const stderr = {
      flush: () => undefined,
      write: vi.fn(),
    }
    // SAFETY: The mock deliberately returns so tests can observe the requested exit status.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    runViteHubCliEntrypoint({
      args: ["--help"],
      loadConfig: async () => ({
        plugins: [],
        root: "/repo",
      }),
      stderr,
      stdout,
    })

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  })

  it("exits unsuccessfully when the process stream fails to flush", async () => {
    // SAFETY: The mock implements the callback overload used by the production flush barrier.
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.(new Error("write failed"))
      return false
    }) as typeof process.stdout.write)
    // SAFETY: The mock deliberately returns so tests can observe the requested exit status.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    runViteHubCliEntrypoint({
      args: ["--help"],
      loadConfig: async () => ({
        plugins: [],
        root: "/repo",
      }),
      stderr: stream(),
    })

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stdoutWrite).toHaveBeenCalledWith("", expect.any(Function))
  })

  it("exits with callback-less configured entrypoint streams", async () => {
    const stdout = stream()
    const stderr = stream()
    // SAFETY: The mock deliberately returns so tests can observe the requested exit status.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    runViteHubCliEntrypoint({
      args: ["--help"],
      loadConfig: async () => ({
        plugins: [],
        root: "/repo",
      }),
      stderr,
      stdout,
    })

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(stdout.output()).toContain("Usage: vitehub")
  })

  it("awaits asynchronous callback-less entrypoint streams before exiting", async () => {
    const flushes: Array<() => void> = []
    const createStream = () => ({
      output: "",
      write(chunk: string | Uint8Array) {
        this.output += String(chunk)
        return new Promise<void>(resolve => flushes.push(resolve))
      },
    })
    const stdout = createStream()
    const stderr = createStream()
    // SAFETY: The mock deliberately returns so tests can observe the requested exit status.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    runViteHubCliEntrypoint({
      args: ["--help"],
      loadConfig: async () => ({
        plugins: [],
        root: "/repo",
      }),
      stderr,
      stdout,
    })
    await vi.waitFor(() => expect(flushes).toHaveLength(1))

    expect(stdout.output).toContain("Usage: vitehub")
    expect(exit).not.toHaveBeenCalled()
    flushes.shift()!()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it("exits unsuccessfully when an asynchronous callback-less write fails", async () => {
    const flush = vi.fn()
    const stdout = {
      flush,
      write: () => Promise.reject(new Error("write failed")),
    }
    const stderr = stream()
    // SAFETY: The mock deliberately returns so tests can observe the requested exit status.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    runViteHubCliEntrypoint({
      args: ["--help"],
      loadConfig: async () => ({
        plugins: [],
        root: "/repo",
      }),
      stderr,
      stdout,
    })

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(flush).toHaveBeenCalledOnce()
  })

  it("flushes and exits when reporting an error throws synchronously", async () => {
    const stdoutFlush = vi.fn()
    const stderrFlush = vi.fn()
    // SAFETY: The mock deliberately returns so tests can observe the requested exit status.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    runViteHubCliEntrypoint({
      args: ["missing"],
      loadConfig: async () => ({
        plugins: [],
        root: "/repo",
      }),
      stderr: {
        flush: stderrFlush,
        write: () => {
          throw new Error("write failed")
        },
      },
      stdout: {
        flush: stdoutFlush,
        write: vi.fn(),
      },
    })

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stdoutFlush).toHaveBeenCalledOnce()
    expect(stderrFlush).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform !== "win32")("forwards SIGQUIT and ignores a missing child process group", async () => {
    const originalKill = process.kill.bind(process)
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === "SIGQUIT") {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
      }
      return originalKill(pid, signal)
    })

    try {
      const exitCode = await runViteHubCli({
        args: ["test", "spawn"],
        loadConfig: async () => ({
          plugins: [{
            vitehub: {
              cli: {
                namespaces: [{
                  features: [{
                    name: "spawn",
                    run: async (_args: string[], context: ViteHubCliContext) => {
                      const result = context.spawn(process.execPath, ["-e", "setTimeout(() => {}, 20)"])
                      await vi.waitFor(() => expect(process.listenerCount("SIGQUIT")).toBeGreaterThan(0))
                      process.emit("SIGQUIT")
                      return (await result).exitCode
                    },
                  }],
                  name: "test",
                }],
              },
            },
          }],
          root: "/repo",
        }),
      })

      expect(exitCode).toBe(0)
      expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGQUIT")
      expect(process.listenerCount("SIGQUIT")).toBe(0)
    }
    finally {
      kill.mockRestore()
    }
  })

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
      }),
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
                features: [{ description: "Run ViteHub Agent Evals.", name: "eval", run: () => undefined, usage: "vitehub agent eval [path] [--watch]" }],
                name: "agent",
              }],
            },
          },
        }],
        root: "/repo",
      }),
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toContain("Usage: vitehub agent <feature>")
    expect(stdout.output()).toContain("eval")
    expect(stdout.output()).toContain("Usage: vitehub agent eval [path] [--watch]")
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
      }),
    })

    expect(exitCode).toBe(0)
    expect(run).toHaveBeenCalledWith(["--help"], expect.objectContaining({ rootDir: "/repo" }))
  })

  it("returns one for unknown namespaces", async () => {
    const stderr = stream()
    const exitCode = await runViteHubCli({
      args: ["kv", "list"],
      loadConfig: async () => ({ plugins: [], root: "/repo" }),
      stderr,
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("Unknown ViteHub CLI namespace: kv")
  })

  it("requires a provider for provision", async () => {
    const stdout = stream()
    const stderr = stream()
    const exitCode = await runViteHubCli({
      args: ["provision", "run"],
      loadConfig: async () => ({ plugins: [], root: "/repo" }),
      stderr,
      stdout,
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("--provider cloudflare|vercel")
    expect(stderr.output()).toContain("Usage: vitehub provision run")
    expect(stdout.output()).toBe("")
  })

  it.each([
    [["--provider"], "Option --provider requires a value."],
    [["--provider="], "Option --provider requires a value."],
    [["--provider", "cloudflare", "unexpected"], "Unknown provision argument: unexpected"],
  ])("rejects invalid provision arguments", async (args, message) => {
    const stderr = stream()
    const exitCode = await runViteHubCli({
      args: ["provision", "run", ...args],
      loadConfig: async () => ({ plugins: [], root: "/repo" }),
      stderr,
      stdout: stream(),
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain(message)
  })

  it("dry-run prints the create-if-absent plan without applying", async () => {
    const rootDir = await createTempDir()
    const apply = vi.fn(async () => ({ ids: { cloudflare: { test: { demo: "id" } } } }))
    const stdout = stream()

    const exitCode = await runViteHubCli({
      args: ["provision", "run", "--provider", "cloudflare", "--dry-run"],
      cwd: rootDir,
      loadConfig: async () => ({ plugins: [provisionPlugin(apply)], root: rootDir }),
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(apply).not.toHaveBeenCalled()
    expect(stdout.output()).toContain("create\ttest-resource\tdemo")
  })

  it("collects provision steps installed by Nuxt modules", async () => {
    const rootDir = await createTempDir()
    const apply = vi.fn(async () => ({ ids: { cloudflare: { test: { demo: "id" } } } }))
    const plan = vi.fn(async () => [{ kind: "test-resource", name: "demo", exists: false, apply }])
    const stdout = stream()

    const exitCode = await runViteHubCli({
      args: ["provision", "run", "--provider", "cloudflare"],
      cwd: rootDir,
      env: { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token" },
      loadNuxtViteConfig: async () => ({
        plugins: [{ vitehub: { cli: { namespaces: [], provision: [{ id: "test:cloudflare", provider: "cloudflare", plan }] } } }],
        root: join(rootDir, "app"),
      }),
      stdout,
    })

    expect(exitCode).toBe(0)
    expect(plan).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(rootDir, "app", ".vitehub", "provision.json"), "utf8")))
      .toEqual({ cloudflare: { test: { demo: "id" } } })
  })

  it("does not append raw Nuxt plugins to an already resolved config", async () => {
    const resolvedPlugin = { name: "resolved" }
    const loadNuxtViteConfig = vi.fn()

    await runViteHubCli({
      args: ["--help"],
      loadConfig: async () => ({ plugins: [resolvedPlugin], root: "/repo", vitehubConfigResolved: true }),
      loadNuxtViteConfig,
      stdout: stream(),
    })

    expect(loadNuxtViteConfig).not.toHaveBeenCalled()
  })

  it("keeps explicit Vite config ownership in the standalone loader", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "vite.config.ts"), "export default {}\n")
    await writeFile(join(rootDir, "nuxt.config.ts"), "export default {}\n")
    const loadNuxtViteConfig = vi.fn()

    await runViteHubCli({
      args: ["--help"],
      cwd: rootDir,
      loadNuxtViteConfig,
      stdout: stream(),
    })

    expect(loadNuxtViteConfig).not.toHaveBeenCalled()
  })

  it("marks standalone Vite config loading as CLI discovery", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "vite.config.ts"), `
export default {
  plugins: [{
    config(config) {
      if (config.vitehubCliDiscovery !== true) throw new Error("fixture state was consumed during CLI discovery")
    },
    name: "fixture-discovery-test",
    vitehub: {
      cli: {
        namespaces: [{ features: [{ name: "run", run: () => 0 }], name: "test" }],
      },
    },
  }],
}
`)

    await expect(runViteHubCli({
      args: ["test", "run"],
      cwd: rootDir,
      stdout: stream(),
    })).resolves.toBe(0)
  })

  it("loads development-only Nuxt contributors during CLI discovery", async () => {
    const rootDir = await createTempDir()
    await mkdir(join(rootDir, "node_modules"))
    await symlink(resolve(import.meta.dirname, "../node_modules/nuxt"), join(rootDir, "node_modules/nuxt"), "dir")
    await writeFile(join(rootDir, "package.json"), "{}\n")
    await writeFile(join(rootDir, "nuxt.config.ts"), `
export default {
  modules: ["./discovery-module.ts"],
}
`)
    await writeFile(join(rootDir, "discovery-module.ts"), `
export default function (_options, nuxt) {
  if (nuxt.options.vitehubCliDiscovery !== true) throw new Error("fixture state was consumed during CLI discovery")
  if (!nuxt.options.dev) return
  nuxt.options.vite.plugins ||= []
  nuxt.options.vite.plugins.push({
    name: "fixture-discovery-test",
    vitehub: {
      cli: {
        namespaces: [{ features: [{ name: "run", run: () => 0 }], name: "test" }],
      },
    },
  })
}
`)

    await expect(runViteHubCli({
      args: ["test", "run"],
      cwd: rootDir,
      stdout: stream(),
    })).resolves.toBe(0)
  })

  it("fails closed when provision credentials are missing", async () => {
    const rootDir = await createTempDir()
    const apply = vi.fn(async () => ({}))
    const stderr = stream()

    const exitCode = await runViteHubCli({
      args: ["provision", "run", "--provider", "cloudflare"],
      cwd: rootDir,
      env: {},
      loadConfig: async () => ({ plugins: [provisionPlugin(apply)], root: rootDir }),
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
      loadConfig: async () => ({ plugins: [provisionPlugin(apply)], root: rootDir }),
      stdout: stream(),
    })

    expect(exitCode).toBe(0)
    expect(apply).toHaveBeenCalledTimes(1)
    const raw = await readFile(join(rootDir, ".vitehub", "provision.json"), "utf8")
    expect(JSON.parse(raw)).toEqual({ cloudflare: { test: { demo: "id-1" } } })
  })
})
