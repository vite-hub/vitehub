// Console links and route segments that ViteHub packages build. Apps use `hostedConsoleUrl()` from the root entry.
export { hostedConsoleOrigin, normalizeConsolePath, normalizeConsoleProjectUrl } from "../hosted-console.ts"
export { consoleInvocationUrl } from "../public-url.ts"
export { decodeRouteSegment, encodeRouteSegment } from "../route-segment.ts"
