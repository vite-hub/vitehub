import { describe, expect, it } from "vitest"

import { queueVercelDeclarations } from "../vite.config.ts"

describe("Queue declaration build", () => {
  it("injects WebSocket types into declarations that expose Vercel functions", () => {
    const bundle = {
      "internal/runtime/vercel-vite.d.ts": { code: "export {}\n", fileName: "internal/runtime/vercel-vite.d.ts", isEntry: true, modules: {}, name: "vercel-vite", type: "chunk" as const },
      "runtime/hosted.d.ts": { code: "export {}\n", fileName: "runtime/hosted.d.ts", isEntry: true, modules: {}, name: "hosted", type: "chunk" as const },
    }
    queueVercelDeclarations.generateBundle({}, bundle)

    for (const chunk of Object.values(bundle)) {
      expect(chunk.code).toBe('/// <reference types="ws" />\nexport {}\n')
    }
  })
})
