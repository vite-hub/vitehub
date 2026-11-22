import { existsSync, readFileSync } from "node:fs"
import { posix } from "node:path"

import type { BundleGroupKind } from "./types.ts"

const frameworkPackages = new Set(["@unhead/vue", "nuxt-nightly", "@vue/reactivity", "@vue/runtime-core", "@vue/runtime-dom", "@vue/server-renderer", "@vue/shared", "crossws", "h3", "nitro", "nuxt", "ocache", "rou3", "srvx", "unhead", "vue", "vue-router"])

function manifestPackageName(manifestFile: string): string | undefined {
  if (!existsSync(manifestFile)) return undefined
  const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8").replace(/^\uFEFF/, ""))
  const name = manifest && typeof manifest === "object" ? Reflect.get(manifest, "name") : undefined
  return typeof name === "string" ? name : undefined
}

/** The root-relative id of a module. Dependencies become `node_modules/<package>/<file>`, wherever pnpm stores them. */
export function moduleId(id: string, root: string, packages: Map<string, string | undefined> = new Map()): string {
  const clean = id.replace(/\\/g, "/").replace(/\?.*$/, "").replace(/^\0/, "")
  const rootPath = root.replace(/\\/g, "/").replace(/\/$/, "")
  const nuxtTemplate = clean.match(/^virtual:nuxt:(.+)$/)
  if (nuxtTemplate) {
    return moduleId(decodeURIComponent(nuxtTemplate[1]!), rootPath, packages)
  }
  const windows = /^[a-z]:\//i.test(clean)
  if (!clean.startsWith("/") && !windows) return clean
  const nodeModules = clean.lastIndexOf("/node_modules/")
  if (nodeModules >= 0) {
    const rest = clean.slice(nodeModules + "/node_modules/".length)
    if (!rest.startsWith(".")) return `node_modules/${rest}`
  }
  const withinRoot = windows ? clean.toLowerCase().startsWith(`${rootPath.toLowerCase()}/`) : clean.startsWith(`${rootPath}/`)
  if (!withinRoot) {
    let dir = posix.dirname(clean)
    while (dir !== ".") {
      if (!packages.has(dir)) {
        packages.set(dir, manifestPackageName(`${dir}/package.json`))
      }
      const name = packages.get(dir)
      if (name) return `node_modules/${name}/${posix.relative(dir, clean)}`
      const parent = posix.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return withinRoot ? clean.slice(rootPath.length + 1) : clean
}

function packageName(path: string): string {
  const parts = path.split("/")
  return parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!
}

/** Names the group of a root-relative module id. */
export function moduleGroup(id: string): { name: string, kind: BundleGroupKind } {
  if (id.startsWith("node_modules/")) {
    const rest = id.slice("node_modules/".length)
    if (rest.startsWith(".")) return { name: rest.includes("/.nuxt/") ? ".nuxt" : `node_modules/${packageName(rest)}`, kind: "generated" }
    const name = packageName(rest)
    if (name === "vite-hub") {
      const feature = rest.split("/")[2]?.replace(/\.js$/, "").replace(/-[\w-]{8}$/, "")
      return { name: feature && feature !== "index" ? `vite-hub/${feature}` : "vite-hub", kind: "vitehub" }
    }
    if (name.startsWith("@vite-hub/")) return { name, kind: "vitehub" }
    if (frameworkPackages.has(name) || name.startsWith("@nuxt/") || name.startsWith("@unhead/")) return { name, kind: "framework" }
    return { name, kind: "dependency" }
  }
  if (id.startsWith("#")) return { name: id.split("/").slice(0, 2).join("/"), kind: "generated" }
  if (id.startsWith("/") || /^[a-z]:\//i.test(id)) return { name: "outside the project", kind: "dependency" }
  if (/^[\w-]+:/.test(id)) return { name: id.split("/")[0]!, kind: "generated" }
  if (!id.includes("/") && !id.includes(".")) return { name: "virtual", kind: "generated" }
  const top = id.split("/")[0]!
  if (top === ".vitehub" || top === ".nuxt" || top === ".nitro" || top === ".output") return { name: top, kind: "generated" }
  const parts = id.split("/")
  return { name: parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0]!, kind: "app" }
}
