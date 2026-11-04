import { afterEach, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
import { readBuiltInEnv } from "../src/internal/builtin-env.ts"
import { installAgentServerEnv } from "../src/server/registry.ts"

afterEach(() => {
  installAgentServerEnv(undefined)
  vi.unstubAllEnvs()
})

it("reads installed Server Env defaults and provider values, replaces cached snapshots, and clears removed configuration", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "host-token")
  const context = { abortSignal: new AbortController().signal }
  const specs = { botToken: { names: ["TELEGRAM_BOT_TOKEN"] as const }, userName: { names: ["TELEGRAM_BOT_USERNAME"] as const } }
  const read = () => readBuiltInEnv("telegram", specs, ["botToken", "userName"], context)
  for (const token of ["first", "second"]) {
    const group = Object.defineProperty({ userName: "default-name" }, "botToken", {
      enumerable: true,
      get: () => { throw new ViteHubError("ENV_ASYNC_REQUIRED", "Provider value requires async loading") },
    })
    const loadServerEnv = vi.fn(async () => ({ telegram: { botToken: token } }))
    installAgentServerEnv({ useServerEnv: () => ({ telegram: group }), loadServerEnv })
    await expect(read()).resolves.toEqual({ botToken: token, userName: "default-name" })
    await expect(read()).resolves.toEqual({ botToken: token, userName: "default-name" })
    expect(loadServerEnv).toHaveBeenCalledExactlyOnceWith(undefined, { signal: context.abortSignal })
  }
  installAgentServerEnv({ useServerEnv: () => ({ telegram: { botToken: undefined } }) })
  await expect(read()).resolves.toEqual({ botToken: undefined, userName: undefined })
  installAgentServerEnv(undefined)
  await expect(read()).resolves.toEqual({ botToken: "host-token", userName: undefined })
})
