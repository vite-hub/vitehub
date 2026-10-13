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
