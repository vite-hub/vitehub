import { isPlainObject } from '@vitehub/internal/object'

export function cloneFeatureOptions<T extends object>(feature: string, options: T): T {
  if (!isPlainObject(options))
    throw new TypeError(`[vitehub] \`${feature}\` must be a plain object.`)

  return { ...options } as T
}

export function normalizeFeatureOptions<T extends object>(
  feature: string,
  options: T | false | undefined,
): T | undefined {
  if (options === false || typeof options === 'undefined')
    return undefined

  return cloneFeatureOptions(feature, options)
}
