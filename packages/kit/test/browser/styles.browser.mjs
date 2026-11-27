import assert from "node:assert/strict"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { inlineWebCss, scopeStyles } from "../../scripts/styles.ts"

const root = fileURLToPath(new URL("./page/", import.meta.url))
const styles = fileURLToPath(new URL("../../src/styles/", import.meta.url))
const src = fileURLToPath(new URL("../../src/", import.meta.url))
const screenshots = process.env.STYLES_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })
const differences = join(tmpdir(), "vitehub-kit-scoped-differences")

const exampleSlots = new Set(["card", "files", "grid", "grip", "hint", "initials", "row", "stack", "tile"])
const unstyledSlots = new Set([
  "autocomplete-list",
  "collapsible",
  "combobox-list",
  "command-group",
  "menu-group",
  "menu-radio-group",
  "navigation-menu-item",
  "otp-input-control",
  "pagination",
  "pagination-item",
  "tags-input-item-text",
  "hover-card-trigger",
])

const openViews = readdirSync(join(root, "open")).map(file => file.replace(/\.vue$/, "")).sort()

const webCss = fileURLToPath(import.meta.resolve("@ui-sdk/core/web.css"))
const family = [webCss, join(styles, "default.css")].map(file => readFileSync(file, "utf8")).join("\n")
const familySlots = new Set([...family.matchAll(/data-slot="([a-z-]+)"/g)].map(match => match[1]))
const familyEndings = [...family.matchAll(/data-slot\$="([a-z-]+)"/g)].map(match => match[1])
const styled = slot => familySlots.has(slot) || familyEndings.some(ending => slot.endsWith(ending))

const scopedFile = fileURLToPath(new URL("../../node_modules/.cache/kit-styles/default.scoped.css", import.meta.url))
mkdirSync(dirname(scopedFile), { recursive: true })
writeFileSync(scopedFile, scopeStyles(inlineWebCss(readFileSync(join(styles, "default.css"), "utf8"), readFileSync(webCss, "utf8"))))

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [vue()],
  resolve: {
    alias: [
      { find: "@vite-hub/kit/styles/default.scoped.css", replacement: scopedFile },
      { find: /^@vite-hub\/kit\/styles\/(.+)$/, replacement: `${styles}$1` },
      { find: /^@vite-hub\/kit\/(.+)$/, replacement: `${src}$1.ts` },
    ],
  },
  root,
  server: { host: "127.0.0.1", port: Number(process.env.STYLES_TEST_PORT ?? 0), strictPort: true },
})
await server.listen()
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})
const base = server.resolvedUrls.local[0]

async function open(query, { width, theme, styles = "" }) {
  const context = await browser.newContext({ viewport: { height: 900, width }, reducedMotion: "reduce" })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}?${query}&theme=${theme}${styles && `&styles=${styles}`}`)
  await page.waitForSelector(".fixture > section")
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  return { context, errors, page }
}

async function renderedSlots(page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll("[data-slot]")]
    .filter((element) => {
      const box = element.getBoundingClientRect()
      return box.width > 1 && box.height > 1 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    })
    .map(element => element.dataset.slot))])
}

async function slotsOutsideScope(page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll("[data-slot]")]
    .filter(element => !element.closest(".ui-sdk") && element.checkVisibility())
    .map(element => element.dataset.slot))])
}

const rasterNoise = 3

async function changedPixels(a, b) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const count = await page.evaluate(async ([urls, noise]) => {
    const images = await Promise.all(urls.map(async url => createImageBitmap(await (await fetch(url)).blob())))
    if (images[0].width !== images[1].width || images[0].height !== images[1].height) return Infinity
    const data = images.map((image) => {
      const canvas = new OffscreenCanvas(image.width, image.height)
      const context = canvas.getContext("2d")
      context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, image.width, image.height).data
    })
    let changed = 0
    for (let index = 0; index < data[0].length; index += 4) {
      for (let channel = 0; channel < 4; channel++) {
        if (Math.abs(data[0][index + channel] - data[1][index + channel]) > noise) {
          changed++
          break
        }
      }
    }
    return changed
  }, [[a, b].map(png => `data:image/png;base64,${png.toString("base64")}`), rasterNoise])
  await context.close()
  return count
}

async function render(name, query, options, { fullPage = true, ready = async () => {} } = {}) {
  const shots = []
  for (const styles of ["", "scoped"]) {
    const { context, errors, page } = await open(query, { ...options, styles })
    await ready(page)
    if (styles) assert.deepEqual(await slotsOutsideScope(page), [], `${name}: parts outside the scope root`)
    else for (const slot of await renderedSlots(page)) seen.add(slot)
    shots.push(await page.screenshot({ animations: "disabled", fullPage }))
    assert.deepEqual(errors, [], `${name} page errors${styles && ` (${styles})`}`)
    await context.close()
  }
  if (screenshots) writeFileSync(join(screenshots, `${name}.png`), shots[0])
  if (shots[0].equals(shots[1])) return
  const changed = await changedPixels(...shots)
  if (changed === 0) return
  mkdirSync(differences, { recursive: true })
  writeFileSync(join(differences, `${name}.png`), shots[0])
  writeFileSync(join(differences, `${name}-scoped.png`), shots[1])
  assert.fail(`${name}: the scoped family ${changed === Infinity ? "changes the page size" : `changes ${changed} pixels`}. See ${differences}.`)
}

const widths = [1440, 390]
const themes = ["light", "dark"]
const seen = new Set()

for (const width of widths) {
  for (const theme of themes) {
    test(`every part, closed and open, at ${width}px in ${theme}, scoped and not`, { timeout: 240_000 }, async () => {
      await render(`all-${width}-${theme}`, "view=all", { width, theme })

      for (const view of openViews) {
        await render(`open-${view}-${width}-${theme}`, `view=${view}`, { width, theme }, {
          fullPage: false,
          ready: async (page) => {
            await page.waitForSelector(`[data-slot="${view}-content"]:not([hidden])`)
            await page.waitForTimeout(500)
          },
        })
        }

      await render(`toast-${width}-${theme}`, "view=toast", { width, theme }, {
        fullPage: false,
        ready: async (page) => {
          await page.locator('[data-part="toast"] button').first().click()
          await page.waitForSelector('[data-slot="toast"]')
          await page.waitForTimeout(500)
        },
      })
    })
  }
}

test("styles every part that renders", () => {
  const missing = [...seen].filter(slot => !styled(slot) && !exampleSlots.has(slot) && !unstyledSlots.has(slot)).sort()
  assert.deepEqual(missing, [], "parts that render without a rule in web.css or src/styles/default.css")
})

test("switches the tokens with .dark and with [data-theme=dark]", async () => {
  const tokens = ["--background", "--foreground", "--popover", "--primary", "--border", "--ring", "--shadow-popover"]
  const read = async theme => {
    const { context, page } = await open("view=button", { width: 800, theme })
    const values = await page.evaluate(names => names.map(name => getComputedStyle(document.documentElement).getPropertyValue(name)), tokens)
    await context.close()
    return values
  }
  const light = await read("light")
  const dark = await read("dark")
  assert.notDeepEqual(dark, light)
  assert.deepEqual(await read("data-dark"), dark)
})

test("switches the scoped tokens with .dark and [data-theme=dark] on the page or on the scope root", async () => {
  const tokens = ["--ui-background", "--ui-foreground", "--ui-border", "--ui-primary", "--ui-ring", "--ui-radius", "--ui-shadow", "color-scheme"]
  const read = async (theme, styles) => {
    const { context, page } = await open("view=button", { width: 800, theme, styles })
    const values = await page.evaluate((names) => {
      const style = getComputedStyle(document.querySelector('[data-slot="button"]'))
      return names.map(name => style.getPropertyValue(name))
    }, tokens)
    await context.close()
    return values
  }
  const light = await read("light")
  const dark = await read("dark")
  assert.notDeepEqual(dark, light)
  assert.deepEqual(await read("light", "scoped"), light)
  assert.deepEqual(await read("dark", "scoped"), dark)
  assert.deepEqual(await read("data-dark", "scoped"), dark)
  assert.deepEqual(await read("root-dark", "scoped"), dark)
})

test("no scoped rule reaches an element outside the scope root", async () => {
  const read = async (styles, focus) => {
    const { context, page } = await open("view=button&outside", { width: 800, theme: "light", styles })
    if (focus) await page.keyboard.press("Tab")
    const values = await page.evaluate(() => [...document.querySelectorAll("#outside *")].map((element) => {
      const computed = {}
      for (const pseudo of [null, "::before", "::after", "::marker"]) {
        const style = getComputedStyle(element, pseudo)
        for (const name of [...style, "--ui-radius", "--ui-border", "--ui-primary", "--ui-background", "--ui-ring"]) computed[`${pseudo ?? ""}${name}`] = style.getPropertyValue(name)
      }
      return { element: element.outerHTML.slice(0, 40), focused: element === document.activeElement, computed }
    }))
    const inside = await page.evaluate(() => getComputedStyle(document.querySelector('#app [data-slot="button"]')).borderRadius)
    await context.close()
    return { inside, values }
  }
  for (const focus of [false, true]) {
    const none = await read("none", focus)
    const scoped = await read("scoped", focus)
    assert.notEqual(scoped.inside, none.inside)
    if (focus) assert.ok(scoped.values.some(value => value.focused), "Tab focuses the button outside the root")
    assert.deepEqual(scoped.values, none.values)
  }
})

test("explicit custom dark palettes override tokens under either system preference", async () => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.setContent('<html class="dark"><head></head><body></body></html>')
    await page.addStyleTag({ content: readFileSync(join(styles, "tokens.css"), "utf8") })
    await page.addStyleTag({ content: ".dark { --background: rgb(10 20 30); --primary: rgb(30 40 50); }" })
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme })
      const tokens = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        return ["--background", "--primary"].map(token => style.getPropertyValue(token).trim())
      })
      assert.deepEqual(tokens, ["rgb(10 20 30)", "rgb(30 40 50)"], colorScheme)
    }
  } finally {
    await context.close()
  }
})
