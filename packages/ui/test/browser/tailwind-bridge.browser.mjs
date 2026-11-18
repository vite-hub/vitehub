// The kit's Tailwind bridge (`@vite-hub/kit/styles/tailwind.css`) must draw every Nuxt UI semantic utility as Nuxt UI
// and the ViteHub theme do. The check builds one Tailwind 4 page twice: with `@import "@nuxt/ui"`, theme.css, and Nuxt
// UI's color plugin (as the Console loads them), and with only the kit tokens and the bridge. It renders one element for
// each utility, in light and dark, and compares the computed colors, borders, rings, and radii.
//
// The utilities are every name Nuxt UI 4.12 registers, the status colors, and every semantic utility that the Console,
// @vite-hub/ui, @vite-hub/docs, and docs/ use, with its opacity modifier.
//
// Run: pnpm --filter @vite-hub/ui test:bridge
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import nuxtUI from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { vitehubTheme } from "../../src/theme.ts"

const root = fileURLToPath(new URL("./tailwind-bridge/", import.meta.url))
const repo = fileURLToPath(new URL("../../../../", import.meta.url))

const steps = ["dimmed", "muted", "toned", "default", "highlighted", "inverted", "elevated", "accented", "bg", "border"]
const colors = ["primary", "success", "info", "warning", "error"]

// The semantic utilities in the code. Tests and generated folders do not count.
function used() {
  const name = `(?:${[...steps, ...colors, "secondary", "neutral"].join("|")})`
  const pattern = new RegExp(`(?<![\\w-])((?:text|bg|border|ring|ring-offset|inset-ring|divide|outline|fill|stroke|decoration|placeholder|caret|accent|shadow|from|via|to)-${name}(?:\\/\\d+)?)(?![\\w-])`, "g")
  const skip = new Set(["node_modules", "dist", ".nuxt", ".output", ".vitehub", ".cache", "test"])
  const found = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(vue|ts|css|md)$/.test(entry) && !/\.test\./.test(entry))
        for (const match of readFileSync(path, "utf8").matchAll(pattern)) found.add(match[1])
    }
  }
  for (const dir of ["packages/vite-hub/src/console", "packages/ui/src", "packages/ui/styles.css", "packages/docs", "docs"]) {
    const path = join(repo, dir)
    if (statSync(path).isDirectory()) walk(path)
    else for (const match of readFileSync(path, "utf8").matchAll(pattern)) found.add(match[1])
  }
  return found
}

// Every name of Nuxt UI's theme block (`--text-color-muted`, `--ring-offset-color-bg`, `--fill-default`, ...).
const registered = [
  ...["dimmed", "muted", "toned", "default", "highlighted", "inverted"].map(step => `text-${step}`),
  ...["default", "muted", "elevated", "accented", "inverted", "border"].map(step => `bg-${step}`),
  ...["border", "ring", "ring-offset", "divide"].flatMap(prefix => ["default", "muted", "accented", "inverted", "bg"].map(step => `${prefix}-${step}`)),
  "outline-default", "outline-inverted",
  ...["stroke", "fill"].flatMap(prefix => ["bg", "default", "inverted"].map(step => `${prefix}-${step}`)),
  ...colors.flatMap(color => ["text", "bg", "border", "ring", "divide", "outline", "fill", "stroke", "accent", "decoration"].map(prefix => `${prefix}-${color}`)),
  ...colors.flatMap(color => [`bg-${color}/10`, `text-${color}/80`, `border-${color}/25`]),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].map(size => `rounded-${size}`),
]
const repoNames = used()
const utilities = [...new Set([...registered, ...repoNames])].sort()

// The classes that make each property visible: a ring needs a width, a divide needs children, and so on.
function element(utility) {
  const [prefix] = utility.match(/^(ring-offset|[a-z]+)/)
  const extra = {
    border: "border",
    decoration: "underline",
    divide: "divide-y",
    outline: "outline",
    ring: "ring-2",
    "ring-offset": "ring-2 ring-offset-2",
  }[prefix] ?? ""
  return { className: `${extra} ${utility}`.trim(), prefix, utility }
}
const elements = utilities.map(element)
const classes = [...new Set(elements.flatMap(entry => entry.className.split(" ")))].join(" ")

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [
    {
      enforce: "pre",
      name: "bridge-classes",
      transform: (code, id) => id.endsWith(".css") && code.includes('@source inline("CLASSES")') ? code.replace('@source inline("CLASSES")', `@source inline(${JSON.stringify(classes)})`) : undefined,
    },
    vue(),
    nuxtUI({ autoImport: false, colorMode: false, components: false, dts: false, ui: { colors: vitehubTheme.colors } }),
  ],
  root,
  server: { host: "127.0.0.1", port: Number(process.env.BRIDGE_TEST_PORT ?? 0), strictPort: true },
})
await server.listen()
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})
const base = server.resolvedUrls.local[0]

const properties = ["color", "background-color", "border-top-color", "box-shadow", "outline-color", "text-decoration-color", "fill", "stroke", "accent-color", "border-top-left-radius"]

async function read(theme, withNuxtUI) {
  const context = await browser.newContext({ colorScheme: theme === "dark" ? "dark" : "light" })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${base}?theme=${theme}${withNuxtUI ? "&nuxt-ui" : ""}`)
  await page.waitForFunction(() => window.ready)
  await page.waitForTimeout(200)
  const values = await page.evaluate(({ elements, properties }) => {
    const fixture = document.querySelector("#fixture")
    const out = {}
    for (const { className, prefix, utility } of elements) {
      const node = document.createElement(prefix === "fill" || prefix === "stroke" ? "span" : prefix === "accent" ? "input" : "div")
      if (prefix === "accent") node.type = "checkbox"
      node.className = className
      node.textContent = prefix === "accent" ? "" : "Text"
      if (prefix === "divide") node.innerHTML = "<p>One</p><p>Two</p>"
      fixture.append(node)
      const target = prefix === "divide" ? node.lastElementChild : node
      const style = getComputedStyle(target)
      out[utility] = Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]))
    }
    const body = getComputedStyle(document.body)
    out.body = { color: body.color, background: body.backgroundColor }
    return out
  }, { elements, properties })
  await context.close()
  return { errors, values }
}

for (const theme of ["light", "dark"]) {
  test(`the bridge draws every utility as Nuxt UI does, in ${theme}`, { timeout: 60_000 }, async () => {
    const nuxt = await read(theme, true)
    const bridge = await read(theme, false)
    assert.deepEqual(nuxt.errors, [], "Nuxt UI page errors")
    assert.deepEqual(bridge.errors, [], "bridge page errors")
    const differences = Object.keys(nuxt.values).flatMap(name => properties.concat(["background"]).flatMap((property) => {
      // theme.css gives every element the focus color as its outline color. That is a theme rule, not a utility.
      if (property === "outline-color" && !name.startsWith("outline-")) return []
      const a = nuxt.values[name][property]
      const b = bridge.values[name][property]
      return a === b ? [] : [`${name} ${property}: Nuxt UI ${a}, bridge ${b}`]
    }))
    assert.deepEqual(differences, [])
    // The check must see real colors, not two pages without styles.
    assert.notEqual(nuxt.values["text-muted"].color, nuxt.values["text-highlighted"].color)
    assert.notEqual(nuxt.values["bg-error/10"]["background-color"], "rgba(0, 0, 0, 0)")
  })
}

test("covers every semantic utility the code uses", () => {
  assert.ok(repoNames.size > 30, `found only ${repoNames.size} names`)
  for (const name of repoNames) assert.ok(utilities.includes(name), name)
})
