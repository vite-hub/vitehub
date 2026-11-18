/** An ETag without its quotes, such as `abc` for `"abc"`. Providers differ in which form they accept for `If-Match`. */
export function bareETag(etag: string): string {
  return etag.length >= 2 && etag.startsWith("\"") && etag.endsWith("\"") ? etag.slice(1, -1) : etag
}
