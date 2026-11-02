import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { transformWithOxc } from "vite"

import { devDefinesVitePlugin, renderDevDefinesNitroPlugin, viteHubRuntimeDefines } from "../src/dev-defines-vite.ts"

const packagesRoot = fileURLToPath(new URL("../..", import.meta.url))

async function declaredRuntimeDefines(): Promise<string[]> {
  const names = new Set<string>()
  for (const name of await readdir(packagesRoot)) {
    const files = await readdir(join(packagesRoot, name, "src"), { recursive: true }).catch(() => [])
    for (const file of files.filter(file => /\.(?:ts|vue)$/.test(file))) {
      const source = await readFile(join(packagesRoot, name, "src", file), "utf8")
      for (const match of source.matchAll(/declare const (__VITEHUB_\w+__)/g)) names.add(match[1]!)
    }
  }
  return [...names].sort()
}

describe("vite dev defines", () => {
  it("sets every define that package code declares", async () => {
    expect(await declaredRuntimeDefines()).toEqual([...viteHubRuntimeDefines].sort())
  })

  it("sets the replaced values as globals and skips missing ones", async () => {
    // Vite replaces the names in the generated plugin. Nitro's `replace` rewrites them in strings too.
    const { code } = await transformWithOxc(renderDevDefinesNitroPlugin(), "dev-defines.mjs", {
      define: { __VITEHUB_APP_BASE_URL__: JSON.stringify("/docs/") },
    })
    // Nitro's `replace` works on the text, like this.
    const replaced = code.replaceAll(/\b__VITEHUB_AUTH_APP_BASE_URL__\b/g, JSON.stringify("/docs/"))
    const scope: Record<string, unknown> = {}
    new Function("globalThis", replaced.replace("export default function", "return function"))(scope)
    expect(scope).toEqual({ __VITEHUB_APP_BASE_URL__: "/docs/", __VITEHUB_AUTH_APP_BASE_URL__: "/docs/" })
  })

  it("runs only for the development server", () => {
    expect(devDefinesVitePlugin().apply).toBe("serve")
  })
})
