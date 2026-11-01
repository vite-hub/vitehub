import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

describe("published gateways package", () => {
  it("asks Jev from plain Node without Vite, Nitro, or the rest of ViteHub", () => {
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url))
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict"
      import { registerHooks } from "node:module"
      import { pathToFileURL } from "node:url"

      // Nothing but advocaat and nostics may load: no Agent package, framework, or generated Server Env module.
      const loaded = []
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (/^(?:@vite-hub\\/(?!gateways)|vite-hub|vite$|vite\\/|nitro|h3|#vitehub)/.test(specifier)) throw new Error("Must not load " + specifier)
          if (!specifier.startsWith(".") && !specifier.startsWith("file:") && !specifier.startsWith("node:")) loaded.push(specifier)
          return nextResolve(specifier, context)
        },
      })

      const { ask, cloudflareTypesafe, typesafe } = await import(pathToFileURL(process.argv[1]).href)
      const requests = []
      const fetch = async (url, init) => {
        requests.push([String(url), init.headers.Authorization, init.headers["cf-aig-authorization"]])
        return Response.json({ answers: { spam: { type: "noul", noul: 0.9 } }, model: "jev-1", usage: { input_tokens: 3, output_tokens: 0 } })
      }
      const questions = { spam: ask.if("Is it spam?") }
      process.env.TYPESAFE_API_KEY = "env-key"
      assert.deepEqual(await typesafe({ fetch }).ask("Win money", questions), { spam: true })
      assert.deepEqual(await cloudflareTypesafe({ apiKey: "ts-key", accountId: "acc", gatewayId: "gw", token: "cf", fetch }).ask("Win money", questions), { spam: true })
      assert.deepEqual(requests, [
        ["https://api.typesafe.ai/v1/systemone", "Bearer env-key", undefined],
        ["https://gateway.ai.cloudflare.com/v1/acc/gw/custom-typesafe/v1/systemone", "Bearer ts-key", "Bearer cf"],
      ])
      assert.deepEqual([...new Set(loaded)].sort(), ["advocaat", "nostics"])
      console.log("ok")
    `, entry], { encoding: "utf8", timeout: 15_000 })
    expect(output.trim()).toBe("ok")
  })

  it("builds an AI SDK model from plain Node and loads only the provider package of its model API", () => {
    const entry = fileURLToPath(new URL("../dist/ai-sdk.js", import.meta.url))
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict"
      import { registerHooks } from "node:module"
      import { pathToFileURL } from "node:url"

      const loaded = []
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (/^(?:@vite-hub\\/(?!gateways)|vite-hub|vite$|vite\\/|nitro|h3|#vitehub|advocaat)/.test(specifier)) throw new Error("Must not load " + specifier)
          if (!specifier.startsWith(".") && !specifier.startsWith("file:") && !specifier.startsWith("node:")) loaded.push(specifier)
          return nextResolve(specifier, context)
        },
      })

      const { languageModel } = await import(pathToFileURL(process.argv[1]).href)
      const { openrouter } = await import(new URL("./index.js", pathToFileURL(process.argv[1])).href)
      const requests = []
      const fetch = async (url, init) => {
        requests.push([String(url), new Headers(init.headers).get("authorization")])
        return Response.json({ choices: [{ finish_reason: "stop", index: 0, message: { content: "Hi", role: "assistant" } }], created: 1, id: "c", model: "m", object: "chat.completion" })
      }
      const model = languageModel(openrouter({ apiKey: "or-key" }), "google/gemini-3-flash", { fetch })
      const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] })
      assert.deepEqual(result.content, [{ type: "text", text: "Hi" }])
      assert.deepEqual(requests, [["https://openrouter.ai/api/v1/chat/completions", "Bearer or-key"]])
      // The chat API loads @ai-sdk/openai-compatible and its own dependencies, never the other providers.
      assert.ok(loaded.includes("@ai-sdk/openai-compatible"))
      assert.ok(!loaded.includes("@ai-sdk/openai") && !loaded.includes("@ai-sdk/anthropic"))
      console.log("ok")
    `, entry], { encoding: "utf8", timeout: 15_000 })
    expect(output.trim()).toBe("ok")
  })

  it("documents itself on npm: the README links only to absolute URLs and its own headings", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]!)
    expect(links.filter(link => !/^(?:https:\/\/|#)/.test(link))).toEqual([])
    for (const heading of ["## Presets", "## Credentials", "## Cloudflare AI Gateway", "## Custom gateways", "## Errors"]) expect(readme).toContain(heading)
  })
})
