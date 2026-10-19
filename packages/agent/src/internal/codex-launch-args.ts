/** One Codex `-c key=value` override. `value` is a TOML value, such as `"text"` or `{ a = "b" }`. */
export function codexConfigArg(key: string, value: string): string {
  return `-c "${`${key}=${value}`.replace(/["\\$`]/g, "\\$&")}"`
}

export function codexLaunchArgs(options: { reasoningEffort?: string, reasoningSummary?: string }): string | undefined {
  const values = [
    options.reasoningEffort && ["model_reasoning_effort", options.reasoningEffort],
    options.reasoningSummary && ["model_reasoning_summary", options.reasoningSummary],
  ].filter((value): value is [string, string] => Boolean(value))
  return values.length
    ? values.map(([key, value]) => codexConfigArg(key, JSON.stringify(value))).join(" ")
    : undefined
}

/**
 * Codex reads at most 32 KiB of AGENTS.md by default. Larger instructions stay
 * in AGENTS.md, so the launch command stays small and Codex keeps its limit.
 */
export const codexDeveloperInstructionsMaxBytes = 32 * 1024

/**
 * Codex renders `developer_instructions` before every message that contains
 * the cwd. AGENTS.md is rendered as `# AGENTS.md instructions for <cwd>`, so a
 * per-invocation cwd ends the shared prompt prefix before the instructions.
 */
export function codexDeveloperInstructionsArg(instructions: string): string {
  // A JSON string is a TOML basic string once lone surrogates and DEL are escaped.
  const value = JSON.stringify(instructions.replace(/\p{Surrogate}/gu, "�")).replaceAll("\u007F", "\\u007f")
  return codexConfigArg("developer_instructions", value)
}
