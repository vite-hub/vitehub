import { describe, it } from "vitest"

import { defineAgent } from "../src/index.ts"
import { bash, db, kv, sandbox, skills } from "../src/capabilities.ts"

describe("agent public types", () => {
  it("accepts capabilities from the capabilities entry", () => {
    defineAgent({
      capabilities: [
        bash(),
        db(),
        kv(),
        skills(),
        sandbox({ commands: ["node"] }),
        {
          id: "custom",
          requires: [{ primitive: "workspace", workspace: { paths: ["CONTEXT.md"], required: true } }],
          tools: {
            lookup: { name: "lookup" },
          },
        },
      ],
      provider: "ai-sdk",
      model: {} as never,
      workspace: { mode: "read" },
    })

    // @ts-expect-error model agents must select an explicit provider
    defineAgent({
      model: {} as never,
    })

    defineAgent({
      provider: "ai-sdk",
      model: {} as never,
      // @ts-expect-error workspace mode must be read or write
      workspace: { mode: "mutable" },
    })
  })
})
