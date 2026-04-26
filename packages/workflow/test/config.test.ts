import { describe, expect, it } from "vitest"

import { normalizeWorkflowOptions } from "../src/config.ts"
import { getCloudflareWorkflowBindingName, getCloudflareWorkflowClassName, getCloudflareWorkflowName } from "../src/integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../src/integrations/vercel.ts"

describe("workflow config", () => {
  it("infers cloudflare from hosting", () => {
    expect(normalizeWorkflowOptions({}, { hosting: "cloudflare-module" })).toEqual({
      provider: "cloudflare",
    })
  })

  it("defaults to vercel", () => {
    expect(normalizeWorkflowOptions(undefined)).toEqual({
      provider: "vercel",
    })
  })

  it("rejects unknown providers", () => {
    expect(() => normalizeWorkflowOptions({ provider: "other" } as never)).toThrow(/Unknown `workflow.provider`/)
  })

  it("creates stable provider names", () => {
    expect(getCloudflareWorkflowBindingName("welcome-email")).toBe("WORKFLOW_77656C636F6D652D656D61696C")
    expect(getCloudflareWorkflowName("welcome-email")).toBe("workflow--77656c636f6d652d656d61696c")
    expect(getCloudflareWorkflowClassName("welcome-email")).toBe("ViteHubWelcomeEmailWorkflow")
    expect(getVercelWorkflowName("welcome-email")).toBe("workflow--77656c636f6d652d656d61696c")
  })
})
