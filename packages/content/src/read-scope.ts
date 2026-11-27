import { extname } from "node:path"

/** Select the same Sources as Comark's hub before it can return a cached artifact or index result. */
export function createContentReadScope(knownNames: readonly string[], basePath: string) {
  // Undefined means all Sources; an empty selection means none. Comark treats an empty name filter as all.
  function names(selected?: string | readonly string[]): readonly string[] | undefined {
    const list = typeof selected === "string" ? [selected] : selected
    if (!list?.length) return undefined
    return list.every(name => knownNames.includes(name)) ? list : []
  }

  function key(path: string): readonly string[] | undefined {
    const first = path.replace(/^\/+/, "").split("/")[0]!
    // Only an instance-prefixed file key takes Comark's fast path; public paths need every manifest.
    return knownNames.includes(first) && extname(path) ? [first] : undefined
  }

  function jsonNames(value: unknown): readonly string[] | undefined {
    if (value === undefined || typeof value === "string") return names(value)
    if (Array.isArray(value) && value.every((name: unknown) => typeof name === "string")) return names(value)
    return []
  }

  function request(request: Request): readonly string[] | undefined {
    const url = new URL(request.url)
    const [rawSection = "", ...parts] = url.pathname.replace(basePath, "").replace(/^\/+/, "").split("/")
    const section = rawSection.replace(/\.json$/, "")
    if (section === "manifest" || section === "snapshot") {
      const name = parts[0]?.replace(/\.json$/, "")
      return name ? names(name) : section === "manifest" ? undefined : []
    }
    if (section === "get") {
      const instance = url.searchParams.get("instance")
      return instance ? names(instance) : key(parts.join("/"))
    }
    if (section === "list" && !parts.length) return undefined
    if (section === "list" || section === "search" || section === "query") {
      try {
        const payload: unknown = JSON.parse(decodeURIComponent(parts.join("/")))
        if (section === "list") return jsonNames(payload)
        if (!payload || typeof payload !== "object") return []
        if (section === "search") return jsonNames("sources" in payload ? payload.sources : undefined)
        const source = ("source" in payload && payload.source) || (knownNames.length === 1 ? knownNames[0] : undefined)
        return typeof source === "string" ? names(source) : []
      }
      catch {
        // Let Comark report malformed routes without loading any Source.
        return []
      }
    }
    // Navigation and custom plugin routes can read across Sources.
    return undefined
  }

  return { names, key, request }
}
