import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { flows } from "./flows.ts"
import { selectedMode, selectedTemplates, startTemplate, type TemplateServer } from "./templates.ts"

for (const template of selectedTemplates) {
  describe(`${template.name} in ${selectedMode}`, () => {
    let server: TemplateServer | undefined

    beforeAll(async () => {
      server = await startTemplate(template, selectedMode)
    }, 900_000)

    afterAll(async () => {
      await server?.stop()
    }, 120_000)

    const app = {
      fetch: (path: string, init?: RequestInit) => fetch(`${server!.origin}${path}`, { ...init, signal: AbortSignal.timeout(60_000) }),
      get origin() { return server!.origin },
    }

    it("serves the home page", async () => {
      const response = await app.fetch("/")

      expect(response.status).toBe(200)
      expect(await response.text()).toContain(`<title>${template.title}</title>`)
    })

    it("serves the home page assets", async () => {
      const response = await app.fetch("/")
      expect(response.status).toBe(200)
      const html = await response.text()

      const stylesheet = html.match(/<link\b[^>]*\srel=["']stylesheet["'][^>]*>/i)?.[0]
      const css = stylesheet?.match(/\shref=["']([^"']+)["']/i)?.[1]
      const script = html.match(/<script\b[^>]*\ssrc=["']([^"']+)["']/i)?.[1]
      expect(script, "home page script").toBeTruthy()
      if (selectedMode !== "dev") expect(css, "home page stylesheet").toBeTruthy()

      for (const [asset, contentType] of [[css, /^text\/css\b/i], [script, /^(?:application|text)\/(?:java|ecma)script\b/i]] as const) {
        if (!asset) continue
        const url = new URL(asset.replaceAll("&amp;", "&"), response.url)
        const assetResponse = await fetch(url, { signal: AbortSignal.timeout(60_000) })
        expect(assetResponse.status, url.href).toBe(200)
        expect(assetResponse.headers.get("content-type"), url.href).toMatch(contentType)
        expect((await assetResponse.arrayBuffer()).byteLength, url.href).toBeGreaterThan(0)
      }
    }, 120_000)

    for (const primitive of template.primitives) {
      it(primitive, async () => {
        const flow = flows[template.name]?.[primitive]
        if (!flow || flow === "pending") throw new Error(`The ${primitive} flow of the ${template.name} template is pending.`)
        await flow(app)
      }, 120_000)
    }
  })
}
