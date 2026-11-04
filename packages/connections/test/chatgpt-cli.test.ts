import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { chatgpt } from "../src/chatgpt.ts"
import { runConnectionsCli } from "../src/cli.ts"
import { defineConnection } from "../src/definition.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createChatGPTFake } from "./chatgpt-fake.ts"
import { createStore } from "./helpers.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

it("signs in through the browser callback and transfers a protected file without printing credentials", async () => {
  const fake = await createChatGPTFake()
  cleanup.push(fake.close)
  await mkdir(".vitest-tmp", { recursive: true })
  const directory = await mkdtemp(join(".vitest-tmp", "chatgpt-cli-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "grant.json")
  const definitions = { chatgpt: defineConnection({ provider: chatgpt({ appName: "CLI test" }), access: { "agent:assistant": { read: true } } }) }
  let runtime = createConnectionsRuntime({ definitions, store: createStore(), fetch: fake.fetch })
  const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => runtime })
  const output = { stdout: "", stderr: "" }
  const context = {
    env: {},
    stdout: { write: (value: string | Uint8Array) => (output.stdout += String(value)) },
    stderr: { write: (value: string | Uint8Array) => (output.stderr += String(value)) },
  }
  let callbackUrl: URL | undefined
  const options = {
    timeout: 5,
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new Request(input, init)),
    openBrowser: async (url: string) => {
      callbackUrl = await fake.callback(url)
      expect((await fetch(callbackUrl)).status).toBe(200)
    },
  }
  const run = (command: string, args: string[] = []) => runConnectionsCli(command, ["chatgpt", ...args], context, options)
  expect(await run("connect")).toBe(0)
  expect(output.stdout).toContain("test@example.com")
  expect(callbackUrl).toBeDefined()
  await expect(fetch(callbackUrl!)).rejects.toThrow()
  expect(await run("inspect")).toBe(0)
  expect(output.stdout).toContain("plan: enabled")
  expect(output.stdout).toContain("expires:")
  expect(output.stdout).toContain("host: urn:uuid:")
  expect(await run("models")).toBe(0)
  expect(output.stdout).toContain("gpt-6.1-sol")
  expect(output.stdout).not.toContain("Hidden")
  const sourceHost = (await runtime.inspect("chatgpt")).chatgpt?.hostId
  expect(await run("export", ["--file", path])).toBe(0)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const sourceStatus = (await runtime.inspect("chatgpt")).status
  expect(sourceStatus).toBe("reauth_required")
  runtime = createConnectionsRuntime({ definitions, store: createStore(), fetch: fake.fetch })
  await chmod(path, 0o644)
  expect(await run("import", ["--file", path])).toBe(1)
  expect(fake.state.refreshes).toBe(0)
  await chmod(path, 0o600)
  expect(await run("import", ["--file", path])).toBe(0)
  expect((await runtime.inspect("chatgpt")).chatgpt?.hostId).not.toBe(sourceHost)
  expect(fake.state.refreshes).toBe(1)
  expect(await run("revoke", ["--confirm", "chatgpt"])).toBe(0)
  expect(fake.state.revoked).toBe(1)
  const credential: Record<string, string> = JSON.parse(await readFile(path, "utf8"))
  for (const key of ["access_token", "refresh_token", "id_token"]) expect(output.stdout + output.stderr).not.toContain(credential[key])
})

it("says at sign-in when the app has no Codex for the ChatGPT gateway", async () => {
  // Outside the repository, so no workspace package resolves @openai/codex.
  const root = await mkdtemp(join(tmpdir(), "chatgpt-codex-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const connection = { actions: [], credential: "chatgpt", chatgpt: { hostId: "urn:uuid:host", plan: "enabled" }, name: "chatgpt", provider: "chatgpt", scopes: { declared: [], granted: [], missing: [] }, status: "connected" }
  const fetch = (async () => Response.json({ connection })) as typeof globalThis.fetch
  const inspect = async (url: string) => {
    let stderr = ""
    const context = { env: {}, rootDir: root, stderr: { write: (value: string | Uint8Array) => (stderr += String(value)) }, stdout: { write: () => true } }
    expect(await runConnectionsCli("inspect", ["chatgpt", "--url", url], context, { fetch })).toBe(0)
    return stderr
  }
  const warning = "Codex is not installed in this app, so an Agent with the ChatGPT gateway cannot answer. Run `pnpm add @openai/codex`, then restart the server. The gateway does not use a codex command from PATH.\n"
  expect(await inspect("http://127.0.0.1:4741")).toBe(warning)
  // A remote app has its own packages.
  expect(await inspect("https://app.example.com")).toBe("")
  await mkdir(join(root, "node_modules/@openai/codex/bin"), { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", private: true }))
  await writeFile(join(root, "node_modules/@openai/codex/package.json"), JSON.stringify({ name: "@openai/codex", version: "0.164.0" }))
  await writeFile(join(root, "node_modules/@openai/codex/bin/codex.js"), "")
  expect(await inspect("http://127.0.0.1:4741")).toBe("")
})
