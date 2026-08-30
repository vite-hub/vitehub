import { describe, expect, it } from "vitest"

import { queueVercelDeclarations } from "../vite.config.ts"

describe("Queue declaration build", () => {
  it("injects WebSocket types into declarations that expose Vercel functions", () => {
    const bundle = {
      "index.d.ts": { code: 'export { waitUntil } from "@vercel/functions"\n', fileName: "index.d.ts", isEntry: true, modules: {}, name: "index", type: "chunk" as const },
      "runtime/hosted.d.ts": { code: 'import { waitUntil } from "@vercel/functions"\nexport { waitUntil }\n', fileName: "runtime/hosted.d.ts", isEntry: true, modules: {}, name: "hosted", type: "chunk" as const },
      "runtime/state.d.ts": { code: "export {}\n", fileName: "runtime/state.d.ts", isEntry: true, modules: {}, name: "state", type: "chunk" as const },
    }
    queueVercelDeclarations.generateBundle({}, bundle)

    expect(bundle["index.d.ts"].code).toBe('/// <reference types="ws" />\nexport { waitUntil } from "@vercel/functions"\n')
    expect(bundle["runtime/hosted.d.ts"].code).toBe('/// <reference types="ws" />\nimport { waitUntil } from "@vercel/functions"\nexport { waitUntil }\n')
    expect(bundle["runtime/state.d.ts"].code).toBe("export {}\n")
  })
})
