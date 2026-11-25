import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"
import { z } from "zod"

import { serveConsolePageAsset, serveConsoleSkills } from "../src/assets.ts"
import { consolePageAssetFiles, consoleSkillsFolder, readConsoleAssets, viteHubPackageRoot } from "../src/assets-build.ts"

const assets = readConsoleAssets()
const root = viteHubPackageRoot()
const get = (path: string, method = "GET") => new Request(`https://console.example.com${path}`, { method })
const indexSchema = z.object({ skills: z.array(z.object({ description: z.string(), files: z.array(z.string()), name: z.string() })) })

function appSkillFiles(): string[] {
  const folder = join(root, consoleSkillsFolder)
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(folder, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()
}

describe("the Console skills", () => {
  it("serve the same index and files as an app on the same ViteHub version", async () => {
    const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version
    expect(assets.version).toBe(version)
    const appIndex = indexSchema.parse(JSON.parse(readFileSync(join(root, consoleSkillsFolder, "index.json"), "utf8")))
    for (const base of [`/skills/${version}`, "/skills/latest", ""]) {
      const response = serveConsoleSkills(get(`${base}/.well-known/skills/index.json`), assets)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
      const index = indexSchema.parse(await response.json())
      expect(index).toEqual(appIndex)
    }
    const listed = ["index.json", ...appIndex.skills.flatMap(skill => skill.files.map(file => `${skill.name}/${file}`))].sort()
    expect(listed).toEqual(appSkillFiles())
    for (const file of listed) {
      const response = serveConsoleSkills(get(`/skills/${version}/.well-known/skills/${file}`), assets)
      expect(response.status, file).toBe(200)
      expect(await response.text()).toBe(readFileSync(join(root, consoleSkillsFolder, file), "utf8"))
    }
  })

  it("name the version they serve when another version is asked for", async () => {
    const response = serveConsoleSkills(get("/skills/0.0.1/.well-known/skills/index.json"), assets)
    expect(response.status).toBe(404)
    expect(await response.text()).toContain(`ViteHub ${assets.version}`)
  })

  it("serve only the skill files", () => {
    for (const path of ["/.well-known/skills/..%2Fpackage.json", "/.well-known/skills/__proto__", "/.well-known/skills/%E0%A4%A", "/skills/latest/index.json"]) {
      expect(serveConsoleSkills(get(path), assets).status, path).toBe(404)
    }
    expect(serveConsoleSkills(get("/.well-known/skills/index.json", "POST"), assets).status).toBe(405)
    const head = serveConsoleSkills(get("/.well-known/skills/index.json", "HEAD"), assets)
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
  })
})

describe("the Console page tools files", () => {
  it.each(Object.keys(consolePageAssetFiles))("serve %s at a URL of its content, cached for a year", async (file) => {
    const asset = assets.page[file]
    expect(asset).toBeDefined()
    const moved = serveConsolePageAsset(get(`/page/${assets.version}/${file}?base=%2Fportal`), assets)
    expect(moved.status).toBe(307)
    expect(moved.headers.get("location")).toBe(`/page/${assets.version}/${asset?.hash}/${file}?base=%2Fportal`)
    expect(moved.headers.get("cache-control")).toBe("public, max-age=300")
    expect(moved.headers.get("access-control-allow-origin")).toBe("*")

    const response = serveConsolePageAsset(get(moved.headers.get("location") ?? ""), assets)
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript; charset=utf-8",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
    })
    expect(await response.text()).toBe(readFileSync(join(root, consolePageAssetFiles[file as keyof typeof consolePageAssetFiles]), "utf8"))
  })

  it("move an old content URL or another version to the current content, without a cache", () => {
    const hash = assets.page["page-tool.js"]?.hash
    for (const path of [`/page/${assets.version}/0123456789abcdef/page-tool.js`, "/page/0.0.1/page-tool.js", `/page/0.0.1/${hash}/page-tool.js`]) {
      const response = serveConsolePageAsset(get(path), assets)
      expect(response.status, path).toBe(307)
      expect(response.headers.get("location")).toBe(`/page/${assets.version}/${hash}/page-tool.js`)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
  })

  it("serve only the page tools files", () => {
    for (const path of [`/page/${assets.version}/loader.js`, `/page/${assets.version}/__proto__`, "/page/page-tool.js", `/page/${assets.version}/a/b/page-tool.js`]) {
      expect(serveConsolePageAsset(get(path), assets).status, path).toBe(404)
    }
    expect(serveConsolePageAsset(get(`/page/${assets.version}/page-tool.js`, "POST"), assets).status).toBe(405)
  })
})
