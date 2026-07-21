import { describe, expect, it } from "vitest"

import { createSandboxTypeTemplateContents } from "../src/type-template.ts"

describe("createSandboxTypeTemplateContents", () => {
  it("generates package payload and result contracts", () => {
    const contents = createSandboxTypeTemplateContents([
      {
        handler: "/app/server/sandboxes/typed/index.ts",
        hasPayloadType: true,
        kind: "package-entry",
        name: "typed",
      },
      {
        handler: "/app/server/sandboxes/untyped/index.ts",
        hasPayloadType: false,
        kind: "package-entry",
        name: "untyped",
      },
    ])

    expect(contents).toContain('"typed": { payload: import("/app/server/sandboxes/typed/index.ts").SandboxPayload')
    expect(contents).toContain('"untyped": { payload: unknown')
    expect(contents).toContain("result: Awaited<typeof import(\"/app/server/sandboxes/typed/index.ts\")['default']>")
  })
})
