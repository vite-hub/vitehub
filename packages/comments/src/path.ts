/** The longest page subject id, in characters. */
export const maximumPagePathLength = 500

/**
 * An app path: one slash, then no second slash or backslash (`//host` and `/\host` leave the site), no whitespace,
 * and no `?` or `#`, which a link adds itself.
 */
const pagePath = /^\/(?![/\\])[^\s\\?#]*$/

export function isPagePath(value: string): boolean {
  return value.length <= maximumPagePathLength && pagePath.test(value)
}
