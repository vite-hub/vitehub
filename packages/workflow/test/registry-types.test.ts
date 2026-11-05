import { describe, expect, it } from "vitest"

import { createWorkflowTypes } from "../src/internal/registry-types.ts"

describe("generated Workflow types", () => {
  it("declares the step files of each folder Workflow", () => {
    expect(createWorkflowTypes("/app/.vitehub/workflow.d.ts", [
      {
        handler: "/app/server/workflows/onboard-user/index.ts",
        name: "onboard-user",
        steps: ["/app/server/workflows/onboard-user/01.create-user.ts", "/app/server/workflows/onboard-user/02-send-welcome.ts"],
      },
      { handler: "/app/server/workflows/cleanup.ts", name: "cleanup" },
      { handler: "/app/server/workflows/digest", name: "digest", steps: ["/app/server/workflows/digest/1.collect.ts"] },
    ], "vite-hub/workflow")).toBe([
      "import \"vite-hub/workflow\"",
      "declare module \"vite-hub/workflow\" {",
      "  interface WorkflowStepRegistry {",
      "    \"onboard-user\": {",
      "      \"createUser\": typeof import(\"../server/workflows/onboard-user/01.create-user.ts\").default",
      "      \"sendWelcome\": typeof import(\"../server/workflows/onboard-user/02-send-welcome.ts\").default",
      "    }",
      "    \"digest\": {",
      "      \"collect\": typeof import(\"../server/workflows/digest/1.collect.ts\").default",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"))
  })
})
