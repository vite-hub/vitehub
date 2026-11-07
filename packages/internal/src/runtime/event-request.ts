function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

function isWebRequest(value: unknown): value is Request {
  if (!isObjectLike(value)) return false
  const headers = Reflect.get(value, "headers")
  return typeof Reflect.get(value, "url") === "string"
    && typeof Reflect.get(value, "method") === "string"
    && isObjectLike(headers)
    && typeof Reflect.get(headers, "get") === "function"
}

/**
 * Return the Web Request of a request or of a Nitro 3 (H3 2) event, which carries it as its own `req`.
 * Throws a `TypeError` for any other value.
 */
export function toEventRequest(event: object): Request {
  if (isWebRequest(event)) return event
  const req: unknown = Object.hasOwn(event, "req") ? Reflect.get(event, "req") : undefined
  if (isWebRequest(req)) return req
  throw new TypeError("[vitehub] Expected a Request or an H3 event with a Web Request.")
}
