import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { localBrowser } from "../src/providers/local.ts"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe("localBrowser", () => {
  it("turns asynchronous Chromium spawn failures into provider errors", async () => {
    const provider = localBrowser({ executablePath: "/vitehub/does-not-exist/chromium" })

    await expect(provider.open()).rejects.toBeInstanceOf(ViteHubError)
    await expect(provider.open()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
  })

  it("applies startupTimeout while the Chromium endpoint is unresponsive", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-test-"))
    tempDirectories.push(root)
    const executablePath = join(root, "unresponsive-browser")
    await writeFile(executablePath, [
      "#!/usr/bin/env node",
      'import { createServer } from "node:http"',
      'const argument = process.argv.find(value => value.startsWith("--remote-debugging-port="))',
      'const port = Number(argument?.slice("--remote-debugging-port=".length))',
      'createServer(() => {}).listen(port, "127.0.0.1")',
      "",
    ].join("\n"))
    await chmod(executablePath, 0o755)
    const provider = localBrowser({ executablePath, startupTimeout: 100 })

    const startedAt = Date.now()
    await expect(provider.open()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it("rejects invalid startup timeouts before opening a browser", () => {
    expect(() => localBrowser({ executablePath: "/chromium", startupTimeout: 0 })).toThrow("startupTimeout must be greater than zero")
    expect(() => localBrowser({ executablePath: "/chromium", startupTimeout: Number.NaN })).toThrow("startupTimeout must be greater than zero")
    expect(() => localBrowser({ executablePath: "/chromium", startupTimeout: 2_147_483_648 })).toThrow("no greater than 2147483647ms")
  })
})
