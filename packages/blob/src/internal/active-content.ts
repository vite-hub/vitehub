// Browsers read a type up to the first space, `;`, or `(`, and use the last valid type of a comma-separated list.
// Check every item, so a type such as `image/png,text/html` cannot pass as a plain image.
function mediaTypeEssences(contentType: string): string[] {
  return contentType.split(",").map(item => /^\s*([^\s;(]*)/.exec(item)![1]!.toLowerCase())
}

const ACTIVE_ESSENCES = new Set(["text/html", "application/xhtml+xml", "text/xml", "application/xml", "text/xsl", "text/rdf"])

/**
 * True for a MIME type that a browser opens as a page that can run script: HTML, XHTML, SVG, XML, and multipart types.
 * A browser can open each part of a multipart body by the type of that part. Serve them in a CSP sandbox, and do not
 * accept them for a broad `ensure` type such as `image` or `text`.
 */
export function isActiveContentType(contentType: string): boolean {
  return mediaTypeEssences(contentType).some(essence =>
    ACTIVE_ESSENCES.has(essence) || essence.endsWith("+xml") || essence.startsWith("multipart/"))
}

// RFC 5987 `attr-char` keeps letters, digits, and !#$&+-.^_`|~. encodeURIComponent() keeps ' ( ) * too.
function encodeAttrValue(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * An RFC 6266 `Content-Disposition: attachment` value. It keeps only the last path segment of `filename`, removes
 * control characters, and sends an ASCII `filename` for old clients and a UTF-8 `filename*`.
 */
export function attachmentDisposition(filename: string): string {
  // A lone surrogate becomes U+FFFD, because encodeURIComponent() throws on it.
  // eslint-disable-next-line no-control-regex -- the header must not carry control characters.
  const name = (filename.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\p{Cs}/gu, "\uFFFD").trim() || "file"
  const ascii = name.replace(/[^\u0020-\u007E]|["\\]/g, "_")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeAttrValue(name)}`
}
