import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it, vi } from "vitest"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../../..")
const tutorialsRoot = resolve(repoRoot, "fixtures/tutorials")
const docsRoot = resolve(repoRoot, "docs/content/docs")

interface DocumentedRequest {
  body: string
  path: string
  response: unknown
}

// Each tutorial page names its request and expected response in labelled code blocks.
// The agents fixture backs the Agent package tests and has no page of its own.
const tutorials: Array<{ fixture: string, request: DocumentedRequest | { page: string } }> = [
  { fixture: "server-primitives", request: { page: "getting-started/first-server-primitive.md" } },
  { fixture: "first-agent", request: { page: "getting-started/first-agent.md" } },
  {
    fixture: "agents",
    request: {
      body: JSON.stringify({ name: "Ada" }),
      path: "/api/greet",
      response: { text: "Hello, Ada. This result came from an Agent Invocation." },
    },
  },
]

function codeBlock(source: string, label: string) {
  const blocks = [...source.matchAll(/```[^\n]*\[([^\]]+)\]\n([\s\S]*?)\n```/g)]
    .filter(match => match[1] === label)
  if (blocks.length !== 1) throw new Error(`Expected one [${label}] code block, found ${blocks.length}`)
  return blocks[0]![2]!
}

async function documentedRequest(page: string): Promise<DocumentedRequest> {
  const source = await readFile(resolve(docsRoot, page), "utf8")
  const curl = codeBlock(source, "commands/request")
  const path = curl.match(/http:\/\/localhost:3000(\/\S*)/)?.[1]
  const body = curl.match(/-d '([^']*)'/)?.[1]
  if (!path || !body) throw new Error(`${page} has no POST request with a JSON body:\n${curl}`)

  return { body, path, response: JSON.parse(codeBlock(source, "output/response.json")) }
}

async function availablePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a tutorial test port")

  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function requestWhenReady(url: string, body: string) {
  let lastError: unknown

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url, {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    }
    catch (error) {
      lastError = error
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }

  throw lastError
}

describe("tutorial fixtures", () => {
  it("memoizes values by key for one invocation", async () => {
    // SAFETY: The tutorial module owns this tested export and the fixture verifies its public callable shape below.
    const { createMemo } = await import(resolve(tutorialsRoot, "agents/src/memo.ts")) as {
      createMemo: () => <T>(key: string, create: () => T) => T
    }
    const create = vi.fn(() => ({ ready: true }))
    const memo = createMemo()

    expect(memo("resource", create)).toBe(memo("resource", create))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each(tutorials)("builds $fixture, starts it, and answers the documented request", async ({ fixture, request }) => {
    const fixtureRoot = resolve(tutorialsRoot, fixture)
    const expected = "page" in request ? await documentedRequest(request.page) : request
    const manifest: { scripts: { build: string, start: string } } = JSON.parse(await readFile(resolve(fixtureRoot, "package.json"), "utf8"))
    // The pages run `pnpm build` and `pnpm start`; these are the commands behind them.
    expect(manifest.scripts).toMatchObject({ build: "vite build", start: "node .output/server/index.mjs" })

    await execFileAsync(resolve(repoRoot, "node_modules/.bin/vp"), ["build"], { cwd: fixtureRoot })

    const port = await availablePort()
    const child = spawn(process.execPath, [".output/server/index.mjs"], {
      cwd: fixtureRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    })
    const exited = once(child, "exit")

    try {
      const response = await requestWhenReady(`http://127.0.0.1:${port}${expected.path}`, expected.body)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(expected.response)
    }
    finally {
      child.kill()
      await exited
    }
  }, 300_000)
})
