type NoExternalValue = string | true | RegExp | (string | RegExp)[] | undefined
type WatchIgnoredMatcher = string | RegExp | ((testString: string, ...args: unknown[]) => boolean)
type WatchIgnoredValue = WatchIgnoredMatcher | WatchIgnoredMatcher[] | undefined

export const generatedViteHubFilesPattern = "**/.vitehub/**"

export function createNoExternalMerger(packageName: string) {
  return (current: NoExternalValue): NoExternalValue => {
    if (current === true) {
      return true
    }
    if (!current) {
      return [packageName]
    }
    const values = Array.isArray(current) ? current : [current]
    return values.includes(packageName) ? values : [...values, packageName]
  }
}

export function isServerEnvironment(name: string, config: { consumer?: string }): boolean {
  return name === "ssr" || config.consumer === "server"
}

export function mergeGeneratedViteHubWatchIgnored(ignored: WatchIgnoredValue): WatchIgnoredValue {
  if (!ignored) return [generatedViteHubFilesPattern]
  if (Array.isArray(ignored)) {
    return ignored.includes(generatedViteHubFilesPattern) ? ignored : [...ignored, generatedViteHubFilesPattern]
  }
  return [ignored, generatedViteHubFilesPattern]
}
