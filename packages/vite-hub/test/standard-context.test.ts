import { createRequire } from "node:module"

import { H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"

import { installStandardContext } from "../src/runtime/h3.ts"
import { renderStandardContextNitroPlugin } from "../src/standard-context-vite.ts"

type RequestHook = (event: H3Event) => void

/** Evaluate the generated plugin with an installer and return the plugin. */
function generatedPlugin(installer: (event: H3Event) => void = installStandardContext): (app: unknown) => void {
  const source = renderStandardContextNitroPlugin()
    .replace(`import { installStandardContext } from "vite-hub/runtime/h3"`, "")
    .replace("export default function", "return function")
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  return new Function("installStandardContext", source)(installer) as (app: unknown) => void
}

/** Run the generated plugin on Nitro 3's hook shape and return its `request` hook. */
function requestHook(): RequestHook {
  const requestHooks: RequestHook[] = []
  generatedPlugin()({ hooks: {
    _hooks: { request: requestHooks },
    hook: (name: string, handler: RequestHook) => {
      if (name === "request") requestHooks.push(handler)
    },
  } })
  return (event) => {
    for (const handler of requestHooks) handler(event)
  }
}

/** Create Nitro 2's real Hookable. */
function nitro2Hooks() {
  const require = createRequire(import.meta.url)
  const { createHooks } = createRequire(require.resolve("nitropack/package.json"))("hookable") as {
    createHooks: () => {
      hook: (name: string, callback: RequestHook) => void
      callHook: (name: string, event: H3Event) => Promise<void>
    }
  }
  return createHooks()
}

describe("generated Standard Context Nitro plugin", () => {
  it("sets `~standard` on each request event", () => {
    const request = new Request("https://app.test/api")
    const event = new H3Event(request)
    requestHook()(event)
    expect(event["~standard"].req).toBe(request)
    expect(event["~standard"].vendor).toBe("h3")
  })

  it("installs before existing consumers with Nitro 2's real Hookable", async () => {
    const hooks = nitro2Hooks()
    const event = new H3Event(new Request("https://app.test/api"))
    hooks.hook("request", request => expect(request["~standard"].req).toBe(request.req))
    generatedPlugin()({ hooks })
    await hooks.callHook("request", event)
  })

  it("installs once per request with Nitro 2's real Hookable", async () => {
    const hooks = nitro2Hooks()
    const installer = vi.fn(installStandardContext)
    generatedPlugin(installer)({ hooks })
    await hooks.callHook("request", new H3Event(new Request("https://app.test/api")))
    expect(installer).toHaveBeenCalledOnce()
  })

  it("prepends the installer before existing Nitro 3 request hooks", () => {
    const event = new H3Event(new Request("https://app.test/api"))
    const hooks: RequestHook[] = [(request) => {
      expect(request["~standard"].req).toBe(request.req)
    }]
    generatedPlugin()({ hooks: { _hooks: { request: hooks }, hook: () => undefined } })
    for (const handler of hooks) handler(event)
  })
})
