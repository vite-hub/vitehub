import { existsSync } from "node:fs"
import { join, posix } from "node:path"

import { findProperty } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import { unwrapExpression } from "./nuxt-config.ts"

import type { Node } from "@babel/types"
import type { NuxtConfigFile } from "./nuxt-config.ts"

/** The app root (`.`) and its local Nuxt layers: `layers/*` and relative `extends` paths. */
export async function localLayerDirectories(cwd: string, config: NuxtConfigFile): Promise<string[]> {
  const layers = await glob(["layers/*"], { cwd, onlyDirectories: true })
  const directories = new Set([".", ...layers.map(layer => layer.replace(/\/$/, ""))])
  const property = findProperty(config.root, "extends")
  const value = property && unwrapExpression(property.value)
  const entries: Array<Node | null> = value?.type === "ArrayExpression" ? value.elements : value ? [value] : []
  for (const entry of entries) {
    const node = entry?.type === "ArrayExpression" ? entry.elements[0] : entry
    if (node?.type !== "StringLiteral" || !node.value.startsWith(".")) continue
    const directory = posix.normalize(node.value)
    if (!directory.startsWith("..") && existsSync(join(cwd, directory))) directories.add(directory)
  }
  return [...directories]
}
