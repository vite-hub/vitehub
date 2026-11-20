export function isWorkersRuntime(): boolean {
  return typeof Reflect.get(globalThis, "WebSocketPair") === "function" || globalThis.navigator?.userAgent === "Cloudflare-Workers"
}
