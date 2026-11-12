import { readFile, readdir } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const contentRoot = resolve(import.meta.dirname, "../content/docs")
const frameworks = ["Nuxt", "Nitro", "Vite"]

/**
 * Config blocks that stay without framework tabs, with the reason. A block here shows something that exists in one
 * framework only, so a tab for the others would show code that does not work.
 */
const singleFramework: Record<string, string> = {
  "development/testing.md vite.config.ts": "Vitest reads a Vite plugin config, including when the app uses Nuxt.",
  "frameworks-hosts/node-self-hosted.md vite.config.ts": "The systemd unit is checked for vitehub() in vite.config.ts builds only, not for the Nuxt module yet.",
  "docs-site/assistant.md nuxt.config.ts": "@vite-hub/docs is a Nuxt module.",
  "docs-site/configure.md nuxt.config.ts": "@vite-hub/docs is a Nuxt module.",
  "docs-site/get-started.md nuxt.config.ts": "@vite-hub/docs is a Nuxt module.",
  "docs-site/index.md nuxt.config.ts": "@vite-hub/docs is a Nuxt module.",
  "docs-site/nuxt-app.md nuxt.config.ts": "The tutorial adds the docs Nuxt module to an existing Nuxt app.",
  "frameworks-hosts/nuxt-server-auto-imports.md nuxt.config.ts": "The page is about the Nuxt module's server auto-imports.",
  "frameworks-hosts/nuxt.md nuxt.config.ts": "The page is about the Nuxt module.",
  "getting-started/migrate-from-nuxthub.md nuxt.config.ts": "The page migrates a NuxtHub app, which is a Nuxt app.",
  "agents/build-a-chat-app.md nuxt.config.ts": "The tutorial builds a Nuxt app with Nuxt UI.",
  "development/console.md nuxt.config.ts": "Nuxt route rules for @nuxtjs/robots have no Vite form.",
  "reference/doctor-rules.md nuxt.config.ts": "Each example shows the config that one Doctor rule reports.",
  "reference/doctor-rules.md vite.config.ts": "Each example shows the config that one Doctor rule reports.",
  "ui/installation.md nuxt/nuxt.config.ts": "The page installs the Vue UI package in Nuxt and in Vite side by side.",
  "ui/installation.md nuxt/defaults/nuxt.config.ts": "The page installs the Vue UI package in Nuxt and in Vite side by side.",
  "ui/installation.md vite/vite.config.ts": "The page installs the Vue UI package in Nuxt and in Vite side by side.",
  "ui/get-started.md nuxt.config.ts": "The tutorial uses the UI Nuxt module. Installation shows Vue with Vite.",
  "agents/process-hosts.md vite.config.ts": "processAgentHost() and agentHostRoutes() set Nitro up from a Vite plugin, which Nuxt does not read.",
  "agents/sandbox-tutorial.md vite.config.ts": "The tutorial runs @vite-hub/sandbox alone with plain Nitro.",
  "auth/configure.md vite.config.ts": "hubAuth(false) and the top-level auth key belong to the package plugin and have no vitehub() form.",
  "comments/configure.md vite.config.ts": "These Database strings belong to comments() used alone.",
  "comments/get-started.md vite.config.ts": "The tutorial adds Comments alone, without a ViteHub app.",
  "comments/get-started.md node/vite.config.ts": "The tutorial adds Comments alone, without a ViteHub app.",
  "comments/index.md vite.config.ts": "The landing shows Comments alone, without a ViteHub app.",
  "frameworks-hosts/cloudflare.md vite.config.ts": "The rate-limit example composes hubRateLimit() and nitro() without vitehub().",
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    // Diagnostic pages are generated from package catalogs and show rule-specific config fragments.
    if (entry.isDirectory() && entry.name !== "diagnostics") files.push(...await markdownFiles(path))
    else if (entry.name.endsWith(".md")) files.push(path)
  }
  return files
}

interface ConfigBlock { label: string, line: number, code: string, tab?: string, group?: number }
interface TabsGroup { id: number, line: number, labels: string[], optional?: boolean }

/** The config code blocks of a page, with the framework tab and tabs group each one sits in. */
function configBlocks(source: string): { blocks: ConfigBlock[], groups: TabsGroup[], unlabeled: number[] } {
  const lines = source.replaceAll("\r\n", "\n").split("\n")
  const blocks: ConfigBlock[] = []
  const unlabeled: number[] = []
  const groups: TabsGroup[] = []
  const stack: { colons: number, name: string, group?: number, tab?: string }[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = /^\s*(`{3,})(\S*)[^[]*(?:\[([^\]]+)\])?/.exec(line)
    if (fence) {
      const close = fence[1]!
      const start = index
      while (++index < lines.length && lines[index]!.trim() !== close);
      const label = fence[3]
      const code = lines.slice(start + 1, index).join("\n")
      // A snippet without a file name that calls vitehub() with options or defines a config hides which file it is.
      if (!label && /^(?:ts|js)$/.test(fence[2]!) && /\bvitehub\(\{|\bdefine(?:Nuxt)?Config\(/.test(code)) unlabeled.push(start + 1)
      if (label && /(?:^|\/)(?:vite|nuxt)\.config\.ts$/.test(label)) {
        const tab = stack.findLast(entry => entry.name === "tabs-item" || entry.name === "framework")?.tab
        const group = tab === undefined ? undefined : stack.findLast(entry => entry.group !== undefined)?.group
        blocks.push({ label, line: start + 1, code, tab, group })
      }
      continue
    }
    const open = /^\s*(:{2,})([a-z][\w-]*)(\{[^}]*\})?\s*$/.exec(line)
    if (open) {
      const entry: { colons: number, name: string, group?: number, tab?: string } = { colons: open[1]!.length, name: open[2]! }
      if (entry.name === "tabs" && /sync="framework"/.test(open[3] ?? "")) {
        entry.group = groups.length
        groups.push({ id: groups.length, line: index + 1, labels: [] })
      }
      // A landing hero's `::code-tree` holds one `::framework{name}` block per framework instead of tabs.
      if (entry.name === "code-tree") {
        entry.group = groups.length
        groups.push({ id: groups.length, line: index + 1, labels: [], optional: true })
      }
      if (entry.name === "tabs-item" || entry.name === "framework") {
        entry.tab = /(?:label|name)="([^"]*)"/.exec(open[3] ?? "")?.[1]
        const group = stack.findLast(item => item.group !== undefined)?.group
        if (group !== undefined && entry.tab) groups[group]!.labels.push(entry.tab)
      }
      stack.push(entry)
      continue
    }
    const close = /^\s*(:{2,})\s*$/.exec(line)
    if (close) {
      const at = stack.findLastIndex(entry => entry.colons === close[1]!.length)
      if (at >= 0) stack.length = at
    }
  }
  return { blocks, groups, unlabeled }
}

/** Removes the indent that every line shares, such as the two spaces of a block inside a landing hero. */
function dedent(code: string): string {
  const lines = code.split("\n")
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.length - line.trimStart().length))
  return lines.map(line => line.slice(Math.min(indent, line.length - line.trimStart().length))).join("\n")
}

/** Index just past the bracket that closes the one at `open`, skipping strings and line comments. */
function closing(code: string, open: number): number {
  let depth = 0
  for (let at = open; at < code.length; at++) {
    const char = code[at]!
    if (char === "'" || char === "\"" || char === "`") at = code.indexOf(char, at + 1)
    else if (char === "/" && code[at + 1] === "/") at = code.indexOf("\n", at)
    else if ("{[(".includes(char)) depth++
    else if ("}])".includes(char) && --depth === 0) return at + 1
    if (at < 0) break
  }
  return code.length
}

/** The top-level `key: value` entries of the object literal at `open`, with normalized values. */
function entries(code: string, open: number): Map<string, string> {
  const body = code.slice(open + 1, closing(code, open) - 1).replace(/\/\/[^\n]*/g, "")
  const out = new Map<string, string>()
  let depth = 0
  let from = 0
  const add = (part: string) => {
    const match = /^\s*([\w$]+)\s*:\s*([\s\S]*?)\s*$/.exec(part)
    if (match) out.set(match[1]!, match[2]!.replace(/\s+/g, " ").replace(/,\s*([}\]])/g, " $1").replaceAll("\"", "'"))
  }
  for (let at = 0; at < body.length; at++) {
    const char = body[at]!
    if (char === "'" || char === "\"" || char === "`") {
      at = body.indexOf(char, at + 1)
      if (at < 0) break
    }
    else if ("{[(".includes(char)) depth++
    else if ("}])".includes(char)) depth--
    else if (char === "," && depth === 0) { add(body.slice(from, at)); from = at + 1 }
  }
  add(body.slice(from))
  return out
}

/** Compare nested object options per key so a Nuxt mode can override one field. */
function flattenOptions(options: Map<string, string>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of options) {
    const path = `${prefix}${key}`
    const nested = value.startsWith("{") ? entries(value, 0) : undefined
    if (nested?.size) {
      for (const [key, value] of flattenOptions(nested, `${path}.`)) out.set(key, value)
    }
    else out.set(path, value)
  }
  return out
}

/**
 * The ViteHub options of a config as `key=value` lines: the argument of `vitehub(...)`, or the `vitehub` key of a
 * Nuxt config. A Vite config declares Env at its top level and Nuxt under `vitehub.env`, so `env` compares per key.
 */
function vitehubOptions(source: string, mode: "development" | "production"): string | undefined {
  // Resolve the literal command condition used by the development-only Console auth example.
  const code = dedent(source).replace(/command\s*===\s*(['"])serve\1\s*\?\s*(false|true|'[^']*'|"[^"]*"|\{[^{}]*\})\s*:\s*(false|true|'[^']*'|"[^"]*"|\{[^{}]*\})/g, mode === "development" ? "$2" : "$3")
  let options: Map<string, string>
  let overrides = new Map<string, string>()
  let env = new Map<string, string>()
  const nuxt = code.indexOf("defineNuxtConfig(")
  if (nuxt >= 0) {
    // Only the key of defineNuxtConfig itself, at two spaces, not a `vitehub` key of a plugin object above it.
    const key = /^ {2}vitehub:\s*/m.exec(code.slice(nuxt))
    if (!key) return code.includes("vite-hub/nuxt") ? "" : undefined
    options = entries(code, nuxt + key.index + key[0].length)
    const modeKey = new RegExp(`^ {2}\\$${mode}:\\s*`, "m").exec(code.slice(nuxt))
    if (modeKey) {
      const config = entries(code, nuxt + modeKey.index + modeKey[0].length).get("vitehub")
      if (config?.startsWith("{")) overrides = entries(config, 0)
    }
  }
  else {
    const call = /vitehub\(/.exec(code)
    if (!call) return undefined
    const open = call.index + call[0].length
    options = code[open] === ")" ? new Map() : entries(code, open)
    const config = /defineConfig\(\{/.exec(code)
    const topEnv = config ? /^ {2}env:\s*/m.exec(code.slice(config.index)) : null
    if (config && topEnv) {
      const at = config.index + topEnv.index + topEnv[0].length
      // A value such as envSchema(...) compares as a whole.
      if (code[at] === "{") env = entries(code, at)
      else options.set("env", code.slice(at, closing(code, code.indexOf("(", at))).replace(/\s+/g, " "))
    }
  }
  const optionEnv = options.get("env")
  if (optionEnv !== undefined && !optionEnv.startsWith("{")) options.set("env", optionEnv.replace(/\s+/g, " "))
  if (optionEnv?.startsWith("{")) {
    options.delete("env")
    for (const [key, value] of entries(optionEnv, 0)) env.set(key, value)
  }
  for (const [key, value] of env) options.set(`env.${key}`, value)
  options = flattenOptions(options)
  for (const [key, value] of flattenOptions(overrides)) {
    // An object override, such as `console: { auth: false }` over `console: true`, replaces the value of its parent.
    for (const parent of options.keys()) if (key.startsWith(`${parent}.`)) options.delete(parent)
    options.set(key, value)
  }
  return [...options].map(([key, value]) => `${key}=${value}`).sort().join("\n")
}

describe("framework tabs", async () => {
  const pages = await Promise.all((await markdownFiles(contentRoot)).map(async path => ({
    page: relative(contentRoot, path),
    ...configBlocks(await readFile(path, "utf8")),
  })))

  it("shows every app config for Nuxt, Nitro, and Vite", () => {
    const missing = pages.flatMap(({ page, blocks }) => blocks
      .filter(block => block.group === undefined && !singleFramework[`${page} ${block.label}`])
      .map(block => `${page}:${block.line} ${block.label}`))
    expect(missing).toEqual([])
  })

  it("names the config file of every config snippet", () => {
    const missing = pages.flatMap(({ page, unlabeled }) => unlabeled.map(line => `${page}:${line}`))
    expect(missing).toEqual([])
  })

  it("orders the tabs Nuxt, Nitro, Vite", () => {
    const wrong = pages.flatMap(({ page, groups }) => groups
      .filter(group => !(group.optional && group.labels.length === 0) && group.labels.join() !== frameworks.join())
      .map(group => `${page}:${group.line} ${group.labels.join(", ")}`))
    expect(wrong).toEqual([])
  })

  it.each(["development", "production"] as const)("passes the same ViteHub options in every tab in %s", (mode) => {
    const drift = pages.flatMap(({ page, blocks }) => {
      const byGroup = Map.groupBy(blocks.filter(block => block.group !== undefined), block => block.group!)
      return [...byGroup.values()].flatMap((group) => {
        const options = new Set(group.map(block => vitehubOptions(block.code, mode)).filter(option => option !== undefined))
        return options.size > 1 ? [`${page}:${group[0]!.line} ${[...options].join(" | ")}`] : []
      })
    })
    expect(drift).toEqual([])
  })
})
