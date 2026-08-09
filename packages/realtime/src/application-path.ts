declare const __VITEHUB_APP_BASE_URL__: string

export function resolveRealtimeApplicationPath(path: string): string {
  const baseURL = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  return baseURL === "/" ? path : `${baseURL.replace(/\/+$/, "")}${path}`
}
