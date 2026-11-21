import { defineHandler } from "nitro/h3"

import { resolveModelEmulation } from "../../../src/internal/agent-emulation.ts"

// A Nitro route that reports what the emulation switch does in the built Worker.
export default defineHandler((event) => {
  const env: unknown = Reflect.get(event.req, "runtime")?.cloudflare?.env
  try {
    return { emulated: resolveModelEmulation({ cloudflare: { env: env as Record<string, unknown> } }) }
  }
  catch (error) {
    return { code: Reflect.get(error as object, "code") }
  }
})
