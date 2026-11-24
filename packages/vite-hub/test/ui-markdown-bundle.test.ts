import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

const packageDir = join(import.meta.dirname, "..")
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

interface AppBundle {
  files: number
  initialBytes: number
  initialFiles: number
  initialPierreFiles: string[]
  pierreFiles: string[]
  totalBytes: number
}

async function buildApp(component: string, specifier: string): Promise<AppBundle> {
  const cache = join(packageDir, "../../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "ui-markdown-bundle-"))
  roots.push(root)
  await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
  await symlink(join(packageDir, "node_modules/vue"), join(root, "node_modules/vue"), "dir")
  await symlink(join(packageDir, "node_modules/@vite-hub/ui"), join(root, "node_modules/@vite-hub/ui"), "dir")
  await symlink(packageDir, join(root, "node_modules/vite-hub"), "dir")
  await writeFile(join(root, "index.html"), "<div id=\"app\"></div><script type=\"module\" src=\"./main.js\"></script>\n")
  await writeFile(join(root, "main.js"), [
    "import { createApp, h } from \"vue\"",
    `import { ${component} } from "${specifier}"`,
    `createApp({ render: () => h(${component}, { patch: "", value: "# Hello" }) }).mount("#app")`,
    "",
  ].join("\n"))
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, "fixtures/ui-markdown-bundle.mjs"), root], {
    env: { ...process.env, NODE_ENV: "production" },
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(await readFile(join(root, "bundle-report.json"), "utf8"))
}

describe("Markdown from the UI root entry", () => {
  it.for(["@vite-hub/ui", "vite-hub/ui"])("keeps %s within the bundle budget without Pierre", { timeout: 240_000 }, async (specifier) => {
    const bundle = await buildApp("Markdown", specifier)
    console.info(`${specifier} Markdown: ${JSON.stringify(bundle)}`)
    expect(bundle.initialPierreFiles).toEqual([])
    expect(bundle.pierreFiles).toEqual([])
    expect(bundle.initialBytes).toBeLessThanOrEqual(140_000)
    expect(bundle.totalBytes).toBeLessThanOrEqual(6_000_000)
    expect(bundle.files).toBeLessThanOrEqual(130)
  })

  it("finds Pierre in a lazy chunk when the app renders a diff", { timeout: 240_000 }, async () => {
    const bundle = await buildApp("PatchDiff", "@vite-hub/ui")
    expect(bundle.initialPierreFiles.filter(fileName => fileName.includes("pierre-code-view"))).toEqual([])
    expect(bundle.pierreFiles.length).toBeGreaterThan(bundle.initialPierreFiles.length)
  })
})
