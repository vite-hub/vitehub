import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { createBrowser } from "../src/client.ts"
import { cdp } from "../src/controllers/cdp.ts"
import { attachCDPPage } from "../src/internal/cdp-page.ts"
import { findChromiumExecutable, localBrowser } from "../src/providers/local.ts"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe("localBrowser", () => {
  it("turns asynchronous Chromium spawn failures into provider errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-test-"))
    tempDirectories.push(root)
    const executablePath = join(root, "chromium")
    await writeFile(executablePath, "not a program")
    const provider = localBrowser({ executablePath })

    await expect(provider.open()).rejects.toBeInstanceOf(ViteHubError)
    await expect(provider.open()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
  })

  it("rejects idleTimeoutMs, which a local Chromium cannot honor", async () => {
    const provider = localBrowser({ executablePath: "/vitehub/does-not-exist/chromium" })

    await expect(provider.open({ idleTimeoutMs: 120_000 })).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
    await expect(provider.open({ idleTimeoutMs: 120_000 })).rejects.toThrow("configure an idle timeout for a local Chromium")
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

  it("names the sandbox fix when Chromium finds no usable sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-test-"))
    tempDirectories.push(root)
    const executablePath = join(root, "sandboxed-browser")
    await writeFile(executablePath, [
      "#!/bin/sh",
      'case "$*" in *--no-sandbox*) sleep 5 ;; esac',
      'echo "FATAL:zygote_host_impl_linux.cc No usable sandbox!" >&2',
      "exit 1",
      "",
    ].join("\n"))
    await chmod(executablePath, 0o755)

    await expect(localBrowser({ executablePath }).open()).rejects.toMatchObject({
      cause: { code: "BROWSER_CHROMIUM_SANDBOX_UNAVAILABLE", fix: expect.stringContaining("BROWSER_SANDBOX=false") },
      code: "BROWSER_PROVIDER_ERROR",
    })
  })

  it("rejects invalid startup timeouts before opening a browser", () => {
    expect(() => localBrowser({ executablePath: "/chromium", startupTimeout: 0 })).toThrow("startupTimeout must be greater than zero")
    expect(() => localBrowser({ executablePath: "/chromium", startupTimeout: Number.NaN })).toThrow("startupTimeout must be greater than zero")
    expect(() => localBrowser({ executablePath: "/chromium", startupTimeout: 2_147_483_648 })).toThrow("no greater than 2147483647ms")
  })
})

describe("findChromiumExecutable", () => {
  it("prefers BROWSER_EXECUTABLE_PATH", () => {
    expect(findChromiumExecutable({ BROWSER_EXECUTABLE_PATH: " /opt/chromium/chrome " })).toBe("/opt/chromium/chrome")
  })

  it.runIf(process.platform === "linux")("finds the newest complete Chromium that Playwright installed", async () => {
    const cache = await mkdtemp(join(tmpdir(), "vitehub-playwright-cache-"))
    tempDirectories.push(cache)
    const install = async (name: string, binary: string, complete = true) => {
      await mkdir(join(cache, name, dirname(binary)), { recursive: true })
      await writeFile(join(cache, name, binary), "")
      if (complete) await writeFile(join(cache, name, "INSTALLATION_COMPLETE"), "")
    }
    await install("chromium-1200", "chrome-linux64/chrome")
    await install("chromium_headless_shell-1255", "chrome-headless-shell-linux64/chrome-headless-shell")
    await install("chromium-1300", "chrome-linux64/chrome", false)

    expect(findChromiumExecutable({ PLAYWRIGHT_BROWSERS_PATH: cache })).toBe(join(cache, "chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell"))
  })

  it("names BROWSER_EXECUTABLE_PATH when the configured Chromium does not exist", async () => {
    const provider = localBrowser({ env: { BROWSER_EXECUTABLE_PATH: "/vitehub/does-not-exist/chromium" } })

    await expect(provider.open()).rejects.toMatchObject({
      code: "BROWSER_CHROMIUM_NOT_FOUND",
      fix: expect.stringContaining("BROWSER_EXECUTABLE_PATH"),
      message: expect.stringContaining("/vitehub/does-not-exist/chromium"),
    })
  })
})

describe.skipIf(!findChromiumExecutable())("localBrowser with the Chromium of this machine", () => {
  it("finds Chromium, opens a page, and reads its title and HTML", async () => {
    const session = await createBrowser({ driver: localBrowser({ sandbox: false }) }).open()
    try {
      const control = await session.attach(cdp())
      try {
        const { page } = await attachCDPPage(control.client)
        await page.goto("data:text/html,<!doctype html><title>Local title</title><p>hi</p>")
        expect(await page.title()).toBe("Local title")
        expect(await page.content()).toBe("<!DOCTYPE html><html><head><title>Local title</title></head><body><p>hi</p></body></html>")
      }
      finally {
        await control.release()
      }
    }
    finally {
      await session.close()
    }
  }, 30_000)
})
