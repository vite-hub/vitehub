import type { BundleGroupKind } from "./types.ts"

const frameworkPackages = new Set(["@unhead/vue", "nuxt-nightly", "@vue/reactivity", "@vue/runtime-core", "@vue/runtime-dom", "@vue/server-renderer", "@vue/shared", "crossws", "h3", "nitro", "nuxt", "ocache", "rou3", "srvx", "unhead", "vue", "vue-router"])

/** The root-relative id of a module. Dependencies become `node_modules/<package>/<file>`, wherever pnpm stores them. */
export function moduleId(id: string, root: string): string {
  const clean = id.replace(/\?.*$/, "").replace(/^\0/, "")
  // Nuxt names its templates `virtual:nuxt:<encoded path>`.
  const nuxtTemplate = clean.match(/^virtual:nuxt:(.+)$/)
  if (nuxtTemplate) {
    const path = decodeURIComponent(nuxtTemplate[1]!)
    return path.startsWith("/") ? moduleId(path, root) : path
  }
  if (!clean.startsWith("/")) return clean
  const nodeModules = clean.lastIndexOf("/node_modules/")
  if (nodeModules >= 0) {
    const rest = clean.slice(nodeModules + "/node_modules/".length)
    // `node_modules/.cache` holds generated output, such as a Nuxt buildDir, not a package.
    if (!rest.startsWith(".")) return `node_modules/${rest}`
  }
  const workspace = clean.match(/\/packages\/([^/]+)\/dist\/(.+)$/)
  if (workspace && !clean.startsWith(`${root}/`)) return `node_modules/${workspace[1] === "vite-hub" ? "vite-hub" : `@vite-hub/${workspace[1]}`}/dist/${workspace[2]}`
  return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean
}

function packageName(path: string): string {
  const parts = path.split("/")
  return parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!
}

/** Names the group of a root-relative module id. */
export function moduleGroup(id: string): { name: string, kind: BundleGroupKind } {
  if (id.startsWith("node_modules/")) {
    const rest = id.slice("node_modules/".length)
    // A Nuxt buildDir under `node_modules/.cache` is still `.nuxt`.
    if (rest.startsWith(".")) return { name: rest.includes("/.nuxt/") ? ".nuxt" : `node_modules/${packageName(rest)}`, kind: "generated" }
    const name = packageName(rest)
    if (name === "vite-hub") {
      // `vite-hub` bundles its features into `dist/<feature>/...` and `dist/<feature>-<hash>.js`.
      const feature = rest.split("/")[2]?.replace(/\.js$/, "").replace(/-[\w-]{8}$/, "")
      return { name: feature && feature !== "index" ? `vite-hub/${feature}` : "vite-hub", kind: "vitehub" }
    }
    if (name.startsWith("@vite-hub/")) return { name, kind: "vitehub" }
    if (frameworkPackages.has(name) || name.startsWith("@nuxt/") || name.startsWith("@unhead/")) return { name, kind: "framework" }
    return { name, kind: "dependency" }
  }
  // `#nitro/virtual/handlers` becomes `#nitro/virtual`, `virtual:vitehub-routes` stays as it is.
  if (id.startsWith("#")) return { name: id.split("/").slice(0, 2).join("/"), kind: "generated" }
  if (/^[\w-]+:/.test(id)) return { name: id.split("/")[0]!, kind: "generated" }
  if (!id.includes("/") && !id.includes(".")) return { name: "virtual", kind: "generated" }
  if (id.startsWith("/")) return { name: "outside the project", kind: "dependency" }
  const top = id.split("/")[0]!
  if (top === ".vitehub" || top === ".nuxt" || top === ".nitro" || top === ".output") return { name: top, kind: "generated" }
  const parts = id.split("/")
  return { name: parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0]!, kind: "app" }
}
