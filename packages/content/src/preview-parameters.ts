/**
 * Marks a preview frame request: the search parameter of the page URL and the form field that carries
 * `{ token, document? }` as JSON. The parameter alone grants nothing.
 */
export const contentPreviewFrameParameter = "vitehub-content-preview"

/**
 * Marks a request that reads `published` only, such as the Published view of the Console side browser: a page URL with
 * `?vitehub-content-published`, or a request whose same-origin `Referer` has it. A preview cookie on that request does
 * not change its reads. The parameter only takes draft access away, so it needs no token.
 */
export const contentPreviewPublishedParameter = "vitehub-content-published"
