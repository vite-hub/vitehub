import { describe, it } from "vitest"

import { bash, defineAgent, sandbox, skills } from "../src/index.ts"

describe("agent public types", () => {
  it("accepts capabilities and rejects root tools", () => {
    defineAgent({
      capabilities: [
        bash(),
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
      // @ts-expect-error root-level tools are not public API
      tools: {},
    })

    defineAgent({
      provider: "ai-sdk",
      model: {} as never,
      // @ts-expect-error workspace mode must be read or write
      workspace: { mode: "mutable" },
    })
  })
})
