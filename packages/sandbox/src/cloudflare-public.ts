export function defineDockerfileFragment(strings: TemplateStringsArray, ...values: unknown[]): void {
  if (!Array.isArray(strings?.raw) || values.length > 0)
    throw new TypeError('[vitehub] `defineDockerfileFragment` must be used as a static tagged template without interpolations.')
}
