import { H3Event } from "h3"
import { describe, expect, it } from "vitest"

import { installStandardContext } from "../src/_internal/runtime/internal/h3.ts"
import { renderStandardContextNitroPlugin } from "../src/standard-context-vite.ts"

type RequestHook = (event: H3Event) => void

/** Evaluate the generated plugin with an installer and return the plugin. */
function generatedPlugin(installer: (event: H3Event) => void = installStandardContext): (app: unknown) => void {
  const source = renderStandardContextNitroPlugin()
    .replace(/^import \{ installStandardContext \} from .*$/m, "")
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

describe("generated Standard Context Nitro plugin", () => {
  it("sets `~standard` on each request event", () => {
    const request = new Request("https://app.test/api")
    const event = new H3Event(request)
    requestHook()(event)
    expect(event["~standard"].req).toBe(request)
    expect(event["~standard"].vendor).toBe("h3")
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
