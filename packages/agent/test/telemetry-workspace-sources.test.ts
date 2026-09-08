import { github } from "@vite-hub/workspace"
import { resolveWorkspaceSources } from "@vite-hub/workspace/runtime"
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

it("retains repositories from resolved GitHub sources without exporting resolution context", async () => {
  const resolved = await resolveWorkspaceSources({
    name: "review",
    sources: {
      docs: github(() => ({ repo: "owner/docs", auth: "private-token", root: "private-path" })),
      invalid: github(() => ({ repo: "https://user:secret@github.com/owner/repo" })),
    },
  }, {
    invocation: {
      context: {
        entries: () => new Map<string, unknown>().entries(),
        get: () => undefined,
        has: () => false,
        toJSON: () => ({}),
      },
    },
  })

  expect(agentTelemetryWorkspaceSources(resolved.sources ?? {})).toEqual([
    { id: "docs", repository: "owner/docs" },
    "invalid",
  ])
})
