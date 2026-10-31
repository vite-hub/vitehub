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

/**
 * The `<meta>` name of the page a preview frame gets when it cannot show the document, such as an expired token or a
 * redirect to another site. Its `content` is the message. The Console shows it with a way to retry.
 */
export const contentPreviewErrorName = "vitehub-content-preview-error"
