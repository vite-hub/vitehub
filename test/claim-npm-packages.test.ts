import { expect, it, vi } from "vitest"

const { npm } = vi.hoisted(() => ({
  npm: vi.fn<(command: string, args: string[]) => { status: number; stdout: string }>(),
}))
vi.mock("node:child_process", () => ({ spawnSync: npm }))

const name = "@vite-hub/device"

it("resumes trust setup without publishing again or replacing an existing publisher", async () => {
  let published = false
  let attempts = 0
  npm.mockImplementation((command, args) => {
    expect(command).toBe("npm")
    let stdout = ""
    let status = 0
    if (args[0] === "access") {
      stdout = JSON.stringify(published ? { [name]: "read-write" } : {})
    }
    else if (args[0] === "publish") {
      expect(published).toBe(false)
      published = true
    }
    else if (args[0] === "trust" && args[1] === "list") {
      expect(args[2]).toBe(name)
      if (attempts === 2) {
        stdout = JSON.stringify({ type: "github", repository: "vite-hub/vitehub", file: "release.yml", environment: "npm-release", permissions: ["createPackage"] })
      }
    }
    else if (args[0] === "trust" && args[1] === "github") {
      expect(args[2]).toBe(name)
      status = ++attempts === 1 ? 1 : 0
    }
    else {
      throw new Error(`Unexpected npm arguments: ${args}`)
    }
    return { status, stdout }
  })

  const argv = process.argv
  process.argv = [...argv.slice(0, 2), name]
  const registry = vi.fn(async () => new Response(null, { status: 404 }))
  vi.stubGlobal("fetch", registry)
  const run = () => {
    vi.resetModules()
    return import("../.github/scripts/claim-npm-packages.mjs")
  }

  try {
    await expect(run()).rejects.toThrow("npm trust failed")
    await run()
    expect(attempts).toBe(2)
    const calls = npm.mock.calls.length
    await run()
    expect(npm.mock.calls.slice(calls).map(([, args]) => args.slice(0, 2))).toEqual([
      ["access", "list"],
      ["trust", "list"],
    ])
    expect(registry).toHaveBeenCalledTimes(1)
  }
  finally {
    process.argv = argv
    vi.unstubAllGlobals()
    npm.mockReset()
  }
})
