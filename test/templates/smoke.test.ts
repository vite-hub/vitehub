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

    for (const primitive of template.primitives) {
      it(primitive, async () => {
        const flow = flows[template.name]?.[primitive]
        if (!flow || flow === "pending") throw new Error(`The ${primitive} flow of the ${template.name} template is pending.`)
        await flow(app)
      }, 120_000)
    }
  })
}
