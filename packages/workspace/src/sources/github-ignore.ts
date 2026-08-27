import { sourceIgnores } from "@vite-hub/source"

export function resolveGitHubIgnore(ignore: false | string | readonly string[] | undefined): string[] | undefined {
  if (ignore === false) return
  return [
    ...sourceIgnores.defaults,
    ...(typeof ignore === "string" ? [ignore] : ignore || []),
  ]
}
