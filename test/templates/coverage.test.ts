import { describe, expect, it } from "vitest"

import { viteHubPrimitiveIds } from "../consumer/packed-app.ts"
import { flows } from "./flows.ts"
import { templates } from "./templates.ts"

const notInTemplates: Record<string, string> = {
  bundle: "Reports the size and startup cost of a build. It adds nothing that runs in the app.",
  cli: "The `vitehub` command. Developers run it next to every template.",
  codemods: "Rewrites app source before it moves to ViteHub. It adds nothing to a new app.",
  console: "The hosted Console that inspects linked apps. It is a separate app, not a part of a template.",
  docs: "The docs-site framework. It adds Nuxt UI, which the templates do not use.",
  runtime: "The shared error and request contracts of every primitive.",
  ui: "Vue parts that the other primitives render.",
  "web-container": "Runs an app inside a browser WebContainer for tutorials. It is not part of a deployed app.",
}

describe("template coverage", () => {
  it("claims every developer-facing primitive in at least one template", async () => {
    const primitives = await viteHubPrimitiveIds()
    const claimed = [...new Set(templates.flatMap(template => template.primitives))].sort()

    expect(claimed).toEqual(primitives.filter(id => !(id in notInTemplates)))
    expect(Object.keys(notInTemplates).filter(id => !primitives.includes(id))).toEqual([])
  })

  it("claims each primitive once per template", () => {
    for (const template of templates) {
      expect(template.primitives, template.name).toEqual([...new Set(template.primitives)])
    }
  })

  it("gives every claimed primitive one smoke flow", () => {
    expect(Object.keys(flows).sort()).toEqual(templates.map(template => template.name))
    for (const template of templates) {
      expect(Object.keys(flows[template.name] ?? {}).sort(), template.name).toEqual([...template.primitives].sort())
    }
  })
})
