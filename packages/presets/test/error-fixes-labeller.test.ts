import { defineAgent } from "@vite-hub/agent"
import { expect, it } from "vitest"

import { presetsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { cleanupLabeller, labeller } from "../src/labeller.ts"

const codes = [
  "PRESETS_LABELLER_ACTIONS_INVALID",
  "PRESETS_LABELLER_ACTION_FLAG_INVALID",
  "PRESETS_LABELLER_ACTION_INVALID",
  "PRESETS_LABELLER_ACTION_LABEL_UNDECLARED",
  "PRESETS_LABELLER_BODY_LIMIT_INVALID",
  "PRESETS_LABELLER_CLEANUP_AGENT_INVALID",
  "PRESETS_LABELLER_CLEANUP_INVALID",
  "PRESETS_LABELLER_CLEANUP_LABEL_NAME_INVALID",
  "PRESETS_LABELLER_CLEANUP_LABEL_UNDECLARED",
  "PRESETS_LABELLER_CLEANUP_OLDER_THAN_INVALID",
  "PRESETS_LABELLER_LABELS_INVALID",
  "PRESETS_LABELLER_LABEL_COUNT_INVALID",
  "PRESETS_LABELLER_LABEL_NAME_INVALID",
  "PRESETS_LABELLER_LABEL_SETTINGS_INVALID",
  "PRESETS_LABELLER_MIN_CONFIDENCE_INVALID",
  "PRESETS_LABELLER_OPTION_NOT_BOOLEAN",
  "PRESETS_LABELLER_PATTERN_INVALID",
  "PRESETS_LABELLER_REGEX_ESCAPE_INVALID",
  "PRESETS_LABELLER_REGEX_FLAGS_INVALID",
  "PRESETS_LABELLER_REGEX_INVALID",
  "PRESETS_LABELLER_REGEX_SYNTAX_UNSUPPORTED",
  "PRESETS_LABELLER_RULES_INVALID",
  "PRESETS_LABELLER_RULE_HEADER_INVALID",
  "PRESETS_LABELLER_RULE_INVALID",
  "PRESETS_LABELLER_RULE_LABEL_MISSING",
  "PRESETS_LABELLER_RULE_LABEL_UNDECLARED",
  "PRESETS_LABELLER_RULE_NESTING_TOO_DEEP",
] as const

function inbox(options: Record<string, unknown>) {
  return defineAgent({ extends: labeller, options: { labels: { Receipts: { description: "Purchases" } }, ...options } })
}

it("gives each Labeller code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: Each code reads only the params that its `why` names; the loop checks the static fields.
    const error = (presetsErrorDiagnostics[code] as (params: { message: string }) => Error & { fix?: string, docs?: string })({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/presets/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports a Labeller without labels with a code and a fix", () => {
  expect(() => inbox({ labels: {} })).toThrow(expect.objectContaining({
    code: "PRESETS_LABELLER_LABEL_COUNT_INVALID",
    fix: expect.stringContaining("labels option"),
    message: "[vitehub] Labeller labels must contain between 1 and 254 labels.",
  }))
})

it("reports a rule with an undeclared label with a code and a fix", () => {
  expect(() => inbox({ rules: { receipts: { subject: "invoice", label: "Missing" } } })).toThrow(expect.objectContaining({
    code: "PRESETS_LABELLER_RULE_LABEL_UNDECLARED",
    fix: expect.stringContaining("Labeller labels option"),
  }))
})

it("reports a regex pattern with repetition with a code and a fix", () => {
  expect(() => inbox({ rules: { receipts: { body: "/a+/", label: "Receipts" } } })).toThrow(expect.objectContaining({
    code: "PRESETS_LABELLER_REGEX_SYNTAX_UNSUPPORTED",
    fix: expect.stringContaining("regex pattern"),
  }))
})

it("reports cleanupLabeller() on another Agent with a code and a fix", async () => {
  // SAFETY: cleanupLabeller() checks at runtime that the Agent extends labeller.
  await expect(cleanupLabeller(defineAgent({ driver: { run: () => "ok" } }) as never)).rejects.toMatchObject({
    code: "PRESETS_LABELLER_CLEANUP_AGENT_INVALID",
    fix: expect.stringContaining("extends: labeller"),
  })
})
