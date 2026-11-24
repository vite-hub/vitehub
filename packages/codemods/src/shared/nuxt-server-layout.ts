import { existsSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

import { keyName } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import { findNuxtConfigName, readNuxtConfig, unwrapExpression } from "./nuxt-config.ts"

import type { Node, ObjectExpression } from "@babel/types"
import type { NuxtConfigFile } from "./nuxt-config.ts"

export const unknownSetting = Symbol("unknown Nuxt setting")
type Setting = Node | undefined | typeof unknownSetting

export function setting(root: ObjectExpression | undefined, ...keys: string[]): Setting {
  let value: Setting = root
  for (const key of keys) {
    if (!value || value === unknownSetting) return value
    if (value.type === "BooleanLiteral") return undefined
    if (value.type !== "ObjectExpression") return unknownSetting
    let next: Setting
    for (const property of value.properties) {
      if (property.type === "SpreadElement" || (property.computed && keyName(property.key, true) === undefined)) next = unknownSetting
      else if (keyName(property.key, property.computed) === key) next = property.type === "ObjectProperty" ? unwrapExpression(property.value) : unknownSetting
    }
    value = next !== unknownSetting && next?.type === "NullLiteral" ? undefined : next
  }
  return value
}

export interface ServerLayer {
  directory: string
  config?: NuxtConfigFile
  server?: string
  shared?: string
}

function configuredDirectory(cwd: string, layer: string, value: Setting, fallback: string): string | undefined {
  if (value !== undefined && (value === unknownSetting || value.type !== "StringLiteral")) return undefined
  return relative(cwd, resolve(cwd, layer, value?.value ?? fallback)).replaceAll("\\", "/") || "."
}

function localDirectory(cwd: string, layer: string, entry: Node | null | undefined): string | undefined {
  if (entry?.type === "ArrayExpression") entry = entry.elements[0]
  if (entry?.type !== "StringLiteral" || (!entry.value.startsWith(".") && !isAbsolute(entry.value))) return undefined
  const directory = resolve(cwd, layer, entry.value)
  if (!existsSync(directory)) return undefined
  return relative(cwd, directory).replaceAll("\\", "/") || "."
}

export async function nuxtServerLayout(cwd: string, config: NuxtConfigFile) {
  const layers = new Map<string, ServerLayer>()
  const unknownLayers = new Set<string>()
  async function visit(directory: string, layerConfig?: NuxtConfigFile): Promise<void> {
    if (layers.has(directory)) return
    if (!layerConfig && findNuxtConfigName(join(cwd, directory))) {
      try {
        layerConfig = await readNuxtConfig(join(cwd, directory))
      }
      catch {
        unknownLayers.add(`${directory}/nuxt.config`)
        return
      }
    }
    const root = layerConfig?.root
    const subroot = configuredDirectory(cwd, directory, setting(root, "rootDir"), ".")
    const serverDir = subroot === undefined ? undefined : configuredDirectory(cwd, subroot, setting(root, "serverDir"), "server")
    const server = serverDir === ".." || serverDir?.startsWith("../") ? undefined : serverDir
    const shared = subroot === undefined ? undefined : configuredDirectory(cwd, subroot, setting(root, "dir", "shared"), "shared")
    layers.set(directory, { directory, config: layerConfig, server, shared })
    const parents = setting(root, "extends")
    if (parents === undefined) return
    const entries: Array<Node | null | typeof unknownSetting> = parents !== unknownSetting && parents.type === "ArrayExpression" ? parents.elements : [parents]
    for (const entry of entries) {
      const parent = entry === unknownSetting ? undefined : localDirectory(cwd, directory, entry)
      if (parent === undefined) unknownLayers.add(`${directory === "." ? "" : `${directory}/`}${layerConfig?.fileName ?? "nuxt.config"} extends`)
      else await visit(parent)
    }
  }
  await visit(".", config)
  for (const path of (await glob("layers/*", { cwd, onlyDirectories: true })).sort().reverse()) await visit(path.replace(/\/$/, ""))
  const ordered = [...layers.values()]
  const effective = (...keys: string[]): Setting => {
    for (const layer of ordered) {
      const value = setting(layer.config?.root, ...keys)
      if (value !== undefined) return value
    }
  }
  const nitro = effective("nitro", "imports")
  const auto = nitro !== unknownSetting && nitro?.type === "BooleanLiteral" && !nitro.value
    ? nitro
    : effective("nitro", "imports", "autoImport") ?? effective("imports", "autoImport")
  const injection = auto === undefined ? true : auto !== unknownSetting && auto.type === "BooleanLiteral" ? auto.value : undefined
  const experimental = effective("experimental", "nitroAutoImports")
  const legacy = effective("nitroLegacy")
  const legacyImports = legacy !== unknownSetting && legacy?.type === "ObjectExpression" ? effective("nitroLegacy", "imports") : legacy
  const presets = experimental !== unknownSetting && experimental?.type === "BooleanLiteral" && experimental.value
    || legacyImports !== unknownSetting && legacyImports?.type === "BooleanLiteral" && legacyImports.value
    || legacy !== unknownSetting && legacy?.type === "ObjectExpression" && legacyImports === undefined
  const computed = (value: Setting) => value !== undefined && (value === unknownSetting || value.type !== "BooleanLiteral")
  const state = injection === false ? "off" : injection === undefined || unknownLayers.size ? "unknown"
    : presets ? "on" : computed(experimental) || computed(legacyImports) ? "unknown" : "off"
  return { layers: ordered, unknownLayers, effective, injection: unknownLayers.size && injection !== false ? undefined : injection, state }
}

export type NuxtServerLayout = Awaited<ReturnType<typeof nuxtServerLayout>>
