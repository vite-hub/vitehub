declare const __VITEHUB_APP_BASE_URL__: string

export function resolveRealtimeApplicationPath(path: string, baseURL = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__): string {
  return baseURL === "/" ? path : `${baseURL.replace(/\/+$/, "")}${path}`
}
