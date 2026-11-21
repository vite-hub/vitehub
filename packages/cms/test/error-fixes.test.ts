import { parseAst } from "vite"
import { expect, it } from "vitest"
import { z } from "zod"

import { defineContent } from "@vite-hub/content"
import { documents } from "@vite-hub/content/collections"

import { readCmsPresetUsage, resolveCmsPresetPlan } from "../src/build.ts"
import { cmsErrorDiagnostics } from "../src/error-diagnostics.ts"
import cms from "../src/index.ts"

import type { CmsDatabaseChoices } from "../src/build.ts"

const fixedCodes = ["CONTENT_B0001", "CONTENT_B0002"] as const
const file = "/app/server/content.ts"

const databases: CmsDatabaseChoices = {
  names: ["default", "audit"],
  resolveDefault: () => ({ name: "default", reason: "default", status: "resolved" }),
}

it("gives each Content build code of the cms preset a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = cmsErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/content/diagnostics/${code.toLowerCase()}`)
  }
})

it("names extends when the build cannot read the cms preset selection", () => {
  const source = "import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/cms'\nexport default defineContent({ extends: [cms, { speed: 'x' }] })\n"

  expect(() => readCmsPresetUsage(source, file, "/app", parseAst)).toThrow(expect.objectContaining({
    code: "CONTENT_B0001",
    fix: expect.stringContaining("`extends: [cms, { ... }]`"),
  }))
})

it("names the preset option when the cms preset asks for a Database that does not exist", () => {
  expect(() => resolveCmsPresetPlan({ file, options: { database: "history" } }, databases, "/app")).toThrow(expect.objectContaining({
    code: "CONTENT_B0002",
    fix: expect.stringContaining("`cms` preset option"),
  }))
})

it("puts the fix of CONTENT_CMS_OPTION_INVALID on the error of a cms preset option that is not valid", () => {
  const collections = { posts: documents({ path: "posts/*.md", fields: { title: z.string() } }) }
  expect(() => defineContent({ extends: [cms, { workspace: "Bad name!" }], collections })).toThrow(expect.objectContaining({
    code: "CONTENT_CMS_OPTION_INVALID",
    docs: "https://vitehub.dev/docs/cms/diagnostics/content_cms_option_invalid",
    fix: cmsErrorDiagnostics.CONTENT_CMS_OPTION_INVALID({ problem: "p" }).fix,
  }))
})
