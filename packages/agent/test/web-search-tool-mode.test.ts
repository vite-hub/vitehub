import { execFile } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { promisify } from "node:util"

import { Provider, register } from "@agntn/web"
import type { ProviderConfig, ReadOptions } from "@agntn/web"
import { describe, expect, it } from "vitest"

import { createWebSearchToolSet } from "../src/capabilities/web-search/tool-mode.ts"

const execFileAsync = promisify(execFile)

class RecordingReader extends Provider {
  static readonly providerName = "jina"
  static readonly defaultBaseURL = "https://reader.example"
  static readonly apiKeyEnvVar = null

  constructor(config: ProviderConfig) {
    super(config, RecordingReader)
  }

  async read(url: string, options?: ReadOptions) {
    return { content: "# ViteHub", metadata: { format: options?.format, maxTokens: options?.maxTokens }, url }
  }
}

interface RecordedSearchRequest {
  apiKey: string | string[] | undefined
  body: unknown
  url: string | undefined
}

async function withSearchServer<T>(callback: (baseURL: string, requests: RecordedSearchRequest[]) => Promise<T>) {
  const requests: RecordedSearchRequest[] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += String(chunk)
    requests.push({ apiKey: request.headers["x-api-key"], body: JSON.parse(body), url: request.url })
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      results: [{ highlights: ["Agents for any host"], title: "ViteHub", url: "https://vitehub.dev" }],
    }))
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP address")

  try {
    return await callback(`http://127.0.0.1:${address.port}`, requests)
  }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe("webSearch tool mode through @agntn/web", () => {
  it("searches with the resolved credential, endpoint, and public search options", async () => {
    await withSearchServer(async (baseURL, requests) => {
      const tools = createWebSearchToolSet({
        apiKey: { unseal: () => "test-exa-key" },
        baseURL,
        name: "exa",
      })

      await expect(tools.web_search.execute?.({
        excludeDomains: ["excluded.example"],
        includeDomains: ["vitehub.dev"],
        maxResults: 3,
        query: "vitehub",
      })).resolves.toMatchObject([{ snippet: "Agents for any host", title: "ViteHub", url: "https://vitehub.dev" }])

      expect(requests).toEqual([{
        apiKey: "test-exa-key",
        body: expect.objectContaining({
          excludeDomains: ["excluded.example"],
          includeDomains: ["vitehub.dev"],
          numResults: 3,
          query: "vitehub",
        }),
        url: "/search",
      }])
    })
  })

  it("reads through the default reader as Markdown with the requested token budget", async () => {
    const unregister = register(RecordingReader)
    try {
      const tools = createWebSearchToolSet("exa")

      await expect(tools.web_read.execute?.({ maxTokens: 512, url: "https://vitehub.dev" })).resolves.toMatchObject({
        content: "# ViteHub",
        metadata: { format: "markdown", maxTokens: 512 },
        url: "https://vitehub.dev",
      })
    }
    finally {
      unregister()
    }
  })

  it("rejects unknown search providers with the provider name", async () => {
    const tools = createWebSearchToolSet("unknown-search-provider")

    await expect(tools.web_search.execute?.({ query: "vitehub" })).rejects.toThrow("unknown-search-provider")
  })

  it("loads @agntn/web on first execution and reports a missing installation", async () => {
    const entry = new URL("../src/capabilities/web-search/tool-mode.ts", import.meta.url)
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import { registerHooks } from "node:module"
      let attempts = 0
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === "@agntn/web") {
          attempts++
          throw Object.assign(new Error("Cannot find package '@agntn/web'"), { code: "ERR_MODULE_NOT_FOUND" })
        }
        return nextResolve(specifier, context)
      } })
      const { createWebSearchToolSet } = await import(${JSON.stringify(entry.href)})
      const tools = createWebSearchToolSet("exa")
      assert.equal(attempts, 0)
      for (const [name, input] of [["web_search", { query: "vitehub" }], ["web_read", { url: "https://vitehub.dev" }]]) {
        await assert.rejects(tools[name].execute(input), (error) => {
          assert.match(error.message, /Install @agntn\\/web or use webSearch\\(\\{ mode: "model" \\}\\)/)
          assert.equal(error.cause.code, "ERR_MODULE_NOT_FOUND")
          return true
        })
      }
      assert.equal(attempts, 1)
      console.log("optional package checked")
    `], { cwd: new URL("..", import.meta.url) })

    expect(stdout.trim()).toBe("optional package checked")
  })
})
