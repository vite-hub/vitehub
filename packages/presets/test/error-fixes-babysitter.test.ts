import { defineAgent } from "@vite-hub/agent"
import { expect, it } from "vitest"

import { babysitter, resolveBabysitterLifecycleFilter } from "../src/babysitter.ts"
import { createBabysitterRuntime } from "../src/babysitter/server.ts"
import { createGitHubHost } from "../src/github/host.ts"
import { presetsErrorDiagnostics } from "../src/error-diagnostics.ts"

const codes = [
  "PRESETS_BABYSITTER_AGENT_INVALID",
  "PRESETS_BABYSITTER_BASE_COMMIT_UNREADABLE",
  "PRESETS_BABYSITTER_DIRECT_MERGE_CLAIM_LOST",
  "PRESETS_BABYSITTER_DRIVER_UNSUPPORTED",
  "PRESETS_BABYSITTER_EXTERNAL_STATE_MISSING",
  "PRESETS_BABYSITTER_GITHUB_LIST_MISSING",
  "PRESETS_BABYSITTER_IGNORE_AUTHORS_INVALID",
  "PRESETS_BABYSITTER_INSTALL_COMMAND_FAILED",
  "PRESETS_BABYSITTER_LIFECYCLE_LABELS_CONFLICT",
  "PRESETS_BABYSITTER_MERGE_QUEUE_QUERY_FAILED",
  "PRESETS_BABYSITTER_NO_FINDINGS_PREFIX_EMPTY",
  "PRESETS_BABYSITTER_TOOL_FIELD_INVALID",
  "PRESETS_BABYSITTER_TOOL_FIELD_MISSING",
  "PRESETS_BABYSITTER_TOOL_PATHS_MISSING",
  "PRESETS_BABYSITTER_TOOL_RUN_ID_MISSING",
  "PRESETS_BABYSITTER_TOOL_UPDATE_EMPTY",
  "PRESETS_BABYSITTER_WAKE_REPOSITORY_UNKNOWN",
] as const

it("gives each Babysitter code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: Each code reads only the params that its `why` names; the loop checks the static fields.
    const error = (presetsErrorDiagnostics[code] as (params: { message: string }) => Error & { fix?: string, docs?: string })({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an invalid Babysitter option with a code and a fix", () => {
  expect(() => defineAgent({ extends: babysitter, options: { modelConcurrency: 0 } })).toThrow(expect.objectContaining({
    code: "PRESETS_BABYSITTER_OPTION_INVALID",
    fix: expect.stringContaining("modelConcurrency"),
    message: "Babysitter modelConcurrency must be a positive integer.",
  }))
})

it("reports both lifecycle labels and filter labels with a code and a fix", () => {
  expect(() => resolveBabysitterLifecycleFilter({ labels: { allow: ["repair"] } }, { labels: { require: ["agent:repair"] } })).toThrow(expect.objectContaining({
    code: "PRESETS_BABYSITTER_LIFECYCLE_LABELS_CONFLICT",
    fix: expect.stringContaining("filter.labels"),
  }))
})

it("reports a runtime for an Agent that does not extend babysitter with a code and a fix", () => {
  const agent = defineAgent({ driver: { run: () => "ok" } })
  const github = createGitHubHost({ credentials: () => ({ token: "token" }) })
  // SAFETY: createBabysitterRuntime() checks at runtime that the Agent extends babysitter.
  expect(() => createBabysitterRuntime({ agent: agent as never, github, concurrency: 1, inboxPath: ":memory:", repositories: ["acme/app"], activityAuthors: [] })).toThrow(expect.objectContaining({
    code: "PRESETS_BABYSITTER_AGENT_INVALID",
    fix: expect.stringContaining("extends: babysitter"),
  }))
})
