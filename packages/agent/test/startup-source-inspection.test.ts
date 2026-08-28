import { describe, expect, it } from "vitest"
import { custom } from "@vite-hub/workspace"

import { createAgentInspectionMetadata, defineAgent } from "../src/index.ts"

describe("startup Source inspection", () => {
  it("reports an unprepared startup Source as pending", () => {
    const agent = defineAgent({
      workspace: {
        sources: {
          docs: custom({
            getItem: async key => ({ content: "# Ready", key }),
            getItems: async () => [{ content: "# Ready", key: "ready.md" }],
            getKeys: async () => ["ready.md"],
            materialize: "startup",
          }),
        },
      },
      driver: { run: () => "ok" },
    })

    expect(createAgentInspectionMetadata(agent).files).toEqual([{
      kind: "directory",
      label: "docs",
      materialize: "startup",
      materialized: false,
      path: "docs",
      source: "docs",
      status: "lazy",
    }])
  })
})
