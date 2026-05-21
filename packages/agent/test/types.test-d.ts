import { describe, it } from "vitest"

import { defineAgent } from "../src/index.ts"
import { bash, db, kv, sandbox, skills } from "../src/capabilities.ts"
import { defineEval, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"

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
      adapter: "ai-sdk",
      model: {} as never,
      workspace: { mode: "read" },
    })

    // @ts-expect-error model agents must select an explicit adapter
    defineAgent({
      model: {} as never,
    })

    defineAgent({
      adapter: "ai-sdk",
      model: {} as never,
      // @ts-expect-error workspace mode must be read or write
      workspace: { mode: "mutable" },
    })

    defineAgent({
      adapter: "ai-sdk",
      model: {} as never,
      // @ts-expect-error adapter settings belong under adapterOptions
      temperature: 0.2,
    })
  })

  it("accepts agent eval definitions", () => {
    const scorer: AgentScorer = textContains("ok")
    const definition: AgentEvalDefinition = {
      agent: defineAgent({
        adapter: "ai-sdk",
        model: {} as never,
      }),
      scenarios: [{
        input: { prompt: "hello" },
        metadata: { area: "support" },
        name: "hello",
        scorers: [scorer],
      }],
      scorers: [scorer],
      variants: [{ name: "strict", instructions: "Be strict.", model: {} }],
    }

    defineEval(definition)

    const observation: AgentObservation = {
      raw: {},
      scenario: "hello",
      text: "ok",
      toolSteps: [],
      variant: "baseline",
    }

    scorer.score(observation)
  })
})
