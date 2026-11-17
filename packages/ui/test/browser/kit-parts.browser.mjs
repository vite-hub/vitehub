// The kit's CSS-only parts (`vh-skeleton`, `vh-empty`, `vh-badge`, `vh-chip`, `vh-alert`, `vh-card`, and
// `vh-avatar-group` in `@vite-hub/kit/styles/default.css`) must look like the Nuxt UI components that the Console uses
// today. The check renders every combination that the Console passes twice: with the Nuxt UI component, the ViteHub app
// config, and theme.css, as the Console does, and as kit markup on the kit tokens, the default family, and the Tailwind
// bridge, with no Nuxt UI. It compares a screenshot of each case pixel by pixel, in light and dark, at 1280px and 390px.
//
// Action buttons are masked: they are UButton on one page and a stand-in of the same size on the other, and the Button
// move is its own unit. The mask still catches a button in another place or of another size. The alert's close button
// is part of the alert, so the check compares it.
//
// A case may differ only by the pixels in `allowed`, each with its cause.
//
// Run: pnpm --filter @vite-hub/ui test:kit-parts
// Set KIT_PARTS_SHOTS=<dir> to save both screenshots and a diff image of each case that differs.
import assert from "node:assert/strict"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import nuxtUI from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { vitehubTheme } from "../../src/theme.ts"

const root = fileURLToPath(new URL("./kit-parts/", import.meta.url))
const shots = process.env.KIT_PARTS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

// The page renders icons with the `@iconify/vue` copy that Nuxt UI uses, so both pages draw the same SVG. The fonts come
// from the kit, which has them as dev dependencies.
const nuxtUIRequire = createRequire(fileURLToPath(import.meta.resolve("@nuxt/ui/vite")))
const fontDir = name => realpathSync(fileURLToPath(new URL(`../../../kit/node_modules/${name}`, import.meta.url)))

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [
    vue(),
    nuxtUI({ autoImport: false, colorMode: false, components: false, dts: false, router: false, ui: vitehubTheme }),
  ],
  resolve: {
    alias: [
      { find: /^@iconify\/vue$/, replacement: nuxtUIRequire.resolve("@iconify/vue") },
      { find: /^@fontsource-variable\/geist$/, replacement: `${fontDir("@fontsource-variable/geist")}/index.css` },
      { find: /^@fontsource-variable\/geist-mono$/, replacement: `${fontDir("@fontsource-variable/geist-mono")}/index.css` },
    ],
  },
  root,
  server: { host: "127.0.0.1", port: Number(process.env.KIT_PARTS_TEST_PORT ?? 0), strictPort: true },
})
await server.listen()
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})
const base = server.resolvedUrls.local[0]

// UBadge draws its text in a `truncate` span, which clips the color fringe (subpixel antialiasing) of the first and the
// last glyph at the span's edge. The kit badge draws its text in the badge, so the fringe shows: up to 10 pixels, each
// in the column next to the text. The boxes, the fill, the ring, and the glyphs are the same.
const glyphFringe = "UBadge clips the subpixel fringe of the first and last glyph"
const allowed = {
  "badge-count": { pixels: 5, why: glyphFringe },
  "badge-md-error": { pixels: 1, why: glyphFringe },
  "badge-md-neutral": { pixels: 1, why: glyphFringe },
  "badge-sm-count": { pixels: 5, why: glyphFringe },
  "badge-sm-neutral": { pixels: 3, why: glyphFringe },
  "badge-sm-success": { pixels: 10, why: glyphFringe },
  "badge-sm-info": { pixels: 3, why: glyphFringe },
}

async function open(side, theme, width) {
  const context = await browser.newContext({ viewport: { height: 900, width }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}?side=${side}&theme=${theme}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  await page.waitForTimeout(200)
  return { context, errors, page }
}

// The skeleton pulse: the timing of each animated element and the frames of its keyframes rule, without the name.
async function animations(page) {
  return page.$$eval("[data-case]", boxes => boxes.flatMap((box) => {
    const element = box.firstElementChild
    const style = getComputedStyle(element)
    if (style.animationName === "none") return []
    const frames = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules]
      }
      catch {
        return []
      }
    }).flatMap(rule => rule.cssRules ? [rule, ...rule.cssRules] : [rule])
      .find(rule => rule instanceof CSSKeyframesRule && rule.name === style.animationName)
    const keyframes = frames ? [...frames.cssRules].map(frame => `${frame.keyText} { ${frame.style.cssText} }`).join(" ") : "missing"
    return [`${box.dataset.case}: ${style.animationDuration} ${style.animationTimingFunction} ${style.animationIterationCount} ${keyframes}`]
  }))
}

// Animations stop before the capture. A running animation puts its element on its own layer, which can move the
// antialiased edge of a neighbor by one shade, and the timing differs between the two pages.
async function capture(page) {
  await page.addStyleTag({ content: "*, ::before, ::after { animation: none !important; transition: none !important }" })
  const ids = await page.$$eval("[data-case]", nodes => nodes.map(node => node.dataset.case))
  const images = {}
  for (const id of ids) {
    const box = page.locator(`[data-case="${id}"]`)
    images[id] = await box.screenshot({ animations: "disabled", caret: "hide", mask: [box.locator("button:not([data-slot=close], [data-slot=vh-alert-close])")], maskColor: "#ff00ff" })
  }
  return images
}

// Counts the pixels that differ, in the browser, and draws them red over a faded copy of the first image.
async function diff(page, a, b) {
  return page.evaluate(async ([a, b]) => {
    const decode = async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext("2d")
      context.drawImage(bitmap, 0, 0)
      return { canvas, context, pixels: context.getImageData(0, 0, bitmap.width, bitmap.height) }
    }
    const left = await decode(a)
    const right = await decode(b)
    if (left.pixels.width !== right.pixels.width || left.pixels.height !== right.pixels.height)
      return { changed: -1, size: `${left.pixels.width}x${left.pixels.height} vs ${right.pixels.width}x${right.pixels.height}` }
    const out = left.context.createImageData(left.pixels.width, left.pixels.height)
    let changed = 0
    for (let index = 0; index < left.pixels.data.length; index += 4) {
      const same = [0, 1, 2, 3].every(offset => left.pixels.data[index + offset] === right.pixels.data[index + offset])
      if (!same) changed++
      const gray = (left.pixels.data[index] + left.pixels.data[index + 1] + left.pixels.data[index + 2]) / 3
      out.data.set(same ? [gray, gray, gray, 60] : [255, 0, 0, 255], index)
    }
    left.context.putImageData(out, 0, 0)
    const blob = await left.canvas.convertToBlob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { changed, total: left.pixels.width * left.pixels.height, image: btoa(binary) }
  }, [a.toString("base64"), b.toString("base64")])
}

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`every Console combination looks the same as kit markup, at ${width}px in ${theme}`, { timeout: 240_000 }, async () => {
      const nuxt = await open("nuxt-ui", theme, width)
      const kit = await open("kit", theme, width)
      assert.deepEqual(await animations(kit.page), await animations(nuxt.page), "the same skeleton pulse")
      const before = await capture(nuxt.page)
      const after = await capture(kit.page)
      assert.deepEqual(nuxt.errors, [], "Nuxt UI page errors")
      assert.deepEqual(kit.errors, [], "kit page errors")
      assert.deepEqual(Object.keys(after), Object.keys(before), "the two pages render the same cases")
      const differences = []
      for (const id of Object.keys(before)) {
        const result = await diff(kit.page, before[id], after[id])
        if (result.changed >= 0 && result.changed <= (allowed[id]?.pixels ?? 0)) continue
        differences.push(result.changed < 0 ? `${id}: size ${result.size}` : `${id}: ${result.changed} of ${result.total} pixels (${(100 * result.changed / result.total).toFixed(2)}%)`)
        if (shots) {
          const name = `${id}-${width}-${theme}`
          writeFileSync(join(shots, `${name}.nuxt-ui.png`), before[id])
          writeFileSync(join(shots, `${name}.kit.png`), after[id])
          if (result.image) writeFileSync(join(shots, `${name}.diff.png`), Buffer.from(result.image, "base64"))
        }
      }
      await nuxt.context.close()
      await kit.context.close()
      assert.deepEqual(differences, [])
    })
  }
}
