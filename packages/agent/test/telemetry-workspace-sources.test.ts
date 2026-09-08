import { github } from "@vite-hub/workspace"
import { expect, it } from "vitest"
import { agentTelemetryWorkspaceSources } from "../src/internal/agent-telemetry.ts"

it("retains GitHub repositories from Workspace sources without exporting credentials or paths", () => {
  const sources = agentTelemetryWorkspaceSources({
    "docs:api": github({ repo: "owner/docs", auth: "private-token", root: "private-path" }),
    bound: { source: github({ repo: "owner/bound" }), mount: "docs" },
    shorthand: { repo: "owner/shorthand", auth: "private-token" },
    local: "./private-file.md",
    invalid: github({ repo: "https://user:secret@github.com/owner/repo" }),
  })
  expect(sources).toEqual([
    { id: "bound", repository: "owner/bound" },
    { id: "docs:api", repository: "owner/docs" },
    "invalid",
    "local",
    { id: "shorthand", repository: "owner/shorthand" },
  ])
})
