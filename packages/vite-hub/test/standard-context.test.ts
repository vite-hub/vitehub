import { H3Event } from "h3"
import { describe, expect, it } from "vitest"

import { installStandardContext } from "../src/runtime/h3.ts"
import { renderStandardContextNitroPlugin } from "../src/standard-context-vite.ts"

type RequestHook = (event: H3Event) => void

/** Evaluate the generated plugin with the runtime installer and return its `request` hook. */
function requestHook(withBeforeEach = true): RequestHook {
  const source = renderStandardContextNitroPlugin()
    .replace(`import { installStandardContext } from "vite-hub/runtime/h3"`, "")
    .replace("export default function", "return function")
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  const plugin = new Function("installStandardContext", source)(installStandardContext) as (app: unknown) => void
  let hook: RequestHook | undefined
  const requestHooks: RequestHook[] = []
  let beforeEach: ((event: { name: string, args: unknown[] }) => void) | undefined
  plugin({ hooks: {
    ...(withBeforeEach ? {
      beforeEach: (handler: (event: { name: string, args: unknown[] }) => void) => { beforeEach = handler },
    } : {}),
    _hooks: { request: requestHooks },
    hook: (name: string, handler: RequestHook) => {
      if (name === "request") requestHooks.push(handler)
    },
  } })
  hook = (event) => {
    beforeEach?.({ name: "request", args: [event] })
    for (const handler of requestHooks) handler(event)
  }
  return hook
}

describe("generated Standard Context Nitro plugin", () => {
  it("sets `~standard` on each request event", () => {
    const request = new Request("https://app.test/api")
    const event = new H3Event(request)
    requestHook()(event)
    expect(event["~standard"].req).toBe(request)
    expect(event["~standard"].vendor).toBe("h3")
  })

  it("falls back to the request hook on Nitro 3", () => {
    const event = new H3Event(new Request("https://app.test/api"))
    requestHook(false)(event)
    expect(event["~standard"].req).toBe(event.req)
  })

  it("prepends the installer before existing Nitro 3 request hooks", () => {
    const event = new H3Event(new Request("https://app.test/api"))
    const hooks: RequestHook[] = [(request) => {
      expect(request["~standard"].req).toBe(request.req)
    }]
    const source = renderStandardContextNitroPlugin()
      .replace(`import { installStandardContext } from "vite-hub/runtime/h3"`, "")
      .replace("export default function", "return function")
    // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
    const plugin = new Function("installStandardContext", source)(installStandardContext) as (app: unknown) => void
    plugin({ hooks: { _hooks: { request: hooks }, hook: () => undefined } })
    for (const handler of hooks) handler(event)
  })
})
