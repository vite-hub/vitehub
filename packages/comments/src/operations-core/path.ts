/** The longest page subject id, in characters. */
export const maximumPagePathLength = 500

/**
 * An app path: one slash, then no second slash or backslash (`//host` and `/\host` leave the site), no whitespace,
 * and no `?` or `#`, which a link adds itself.
 */
const pagePath = /^\/(?![/\\])[^\s\\?#]*$/

export function isPagePath(value: string): boolean {
  return value.length <= maximumPagePathLength && pagePath.test(value)
    && !new URL(value, "https://comments.invalid").pathname.startsWith("//")
}

const pageURL = /^https?:\/\//i

/**
 * The path of a page that a person names by its full URL, such as `https://site.test/pricing?plan=pro`: `/pricing`.
 * Other values return unchanged, so a path stays a path and garbage stays garbage.
 */
export function pagePathOf(value: string): string {
  return pageURL.test(value) && URL.canParse(value) ? new URL(value).pathname : value
}
