import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Attributes of every source SVG. A source that changes them is not part of the set. */
export const sourceRoot = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">`

/** The source attributes in the form that an Iconify body keeps them: on a group, because Iconify replaces the root. */
const bodyGroup = `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5">`

const svgDir = new URL("../svg/", import.meta.url)

/** Reads `svg/<name>.svg` and returns the Iconify body of each icon, in name order. */
export function readIconBodies(): Record<string, string> {
  const names = readdirSync(svgDir).filter(file => file.endsWith(".svg")).map(file => file.slice(0, -4)).sort()
  return Object.fromEntries(names.map((name) => {
    const source = readFileSync(new URL(`${name}.svg`, svgDir), "utf8").trim()
    if (!source.startsWith(sourceRoot) || !source.endsWith("</svg>")) throw new Error(`svg/${name}.svg must start with ${sourceRoot}`)
    const shapes = source.slice(sourceRoot.length, -"</svg>".length).replace(/>\s+</g, "><").trim()
    return [name, `${bodyGroup}${shapes}</g>`]
  }))
}

export function buildIconSet(bodies: Record<string, string>) {
  return {
    prefix: "vitehub",
    info: {
      name: "ViteHub",
      total: Object.keys(bodies).length,
      author: { name: "ViteHub", url: "https://github.com/vite-hub/vitehub/tree/main/packages/icons" },
      license: { title: "Apache 2.0", spdx: "Apache-2.0", url: "https://github.com/vite-hub/vitehub/blob/main/LICENSE" },
      height: 24,
      category: "UI 24px",
      palette: false,
    },
    icons: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, { body }])),
    width: 24,
    height: 24,
  }
}

function declarations(names: string[]): string {
  return `/** Name of an icon in the ViteHub set, such as \`kv\` for \`i-vitehub-kv\`. */
export type ViteHubIconName = ${names.map(name => JSON.stringify(name)).join(" | ")}

/** The ViteHub icon set in the Iconify JSON format, as \`@iconify-json/*\` packages export it. */
export interface ViteHubIconSet {
  prefix: "vitehub"
  info: {
    name: string
    total: number
    author: { name: string, url: string }
    license: { title: string, spdx: string, url: string }
    height: number
    category: string
    palette: boolean
  }
  icons: Record<ViteHubIconName, { body: string }>
  width: 24
  height: 24
}

export declare const icons: ViteHubIconSet
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const set = buildIconSet(readIconBodies())
  const dist = new URL("../dist/", import.meta.url)
  mkdirSync(dist, { recursive: true })
  writeFileSync(new URL("index.js", dist), `export const icons = ${JSON.stringify(set, null, 2)}\n`)
  writeFileSync(new URL("index.d.ts", dist), declarations(Object.keys(set.icons)))
  console.log(`dist: ${set.info.total} icons`)
}
