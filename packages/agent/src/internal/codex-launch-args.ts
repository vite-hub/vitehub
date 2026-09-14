export function codexLaunchArgs(options: { reasoningEffort?: string, reasoningSummary?: string }): string | undefined {
  const values = [
    options.reasoningEffort && ["model_reasoning_effort", options.reasoningEffort],
    options.reasoningSummary && ["model_reasoning_summary", options.reasoningSummary],
  ].filter((value): value is [string, string] => Boolean(value))
  return values.length
    ? values.map(([key, value]) => {
        const config = `${key}=${JSON.stringify(value)}`
        return `-c "${config.replace(/["\\$`]/g, "\\$&")}"`
      }).join(" ")
    : undefined
}
