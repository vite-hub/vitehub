import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"
import { array, object, optional, parse, picklist, string } from "valibot"

import { frameworks, frameworkView } from "../modules/tutorials/build"

const docsRoot = resolve(import.meta.dirname, "..")
const fixturesRoot = resolve(import.meta.dirname, "../../fixtures/docs-hosts")

const snippetContractsSchema = array(object({
  fixture: string(),
  label: string(),
  page: string(),
  verification: picklist(["build", "json", "typecheck"]),
  framework: optional(picklist(frameworks)),
}))

function normalize(source: string) {
  return source.trim().replaceAll("\r\n", "\n")
}

function sourceBlocks(source: string) {
  return [...normalize(source).matchAll(/```(ts|json) \[(.+)\][^\n]*\n([\s\S]*?)\n```/g)].map(match => ({
    label: match[2]!,
    language: match[1]!,
    source: normalize(match[3]!),
  }))
}

async function readContracts() {
  return parse(snippetContractsSchema, JSON.parse(await readFile(resolve(fixturesRoot, "manifest.json"), "utf8")))
}

describe("launch-critical documentation snippets", () => {
  it.each(["vite.config.ts", "server/routes/videos/[file].ts"])("reads %s source blocks from CRLF pages", (label) => {
    expect(sourceBlocks(`\`\`\`ts [${label}]\r\nexport default {}\r\n\`\`\`\r\n`)).toEqual([
      { label, language: "ts", source: "export default {}" },
    ])
  })

  it("shows every fixture on its page and sources every JSON block from a fixture", async () => {
    const contracts = await readContracts()
    const pages = [...new Set(contracts.map(contract => contract.page))]

    expect(contracts).toHaveLength(15)

    // A block outside the framework tabs has one contract for every framework. A block in a tab names its framework.
    // docs/scripts/check-snippets.mjs type-checks the TypeScript blocks, so only JSON blocks need a fixture each.
    for (const page of pages) {
      const markdown = await readFile(resolve(docsRoot, "content/docs", page), "utf8")
      for (const framework of frameworks) {
        const blocks = sourceBlocks(frameworkView(markdown, framework))
        const pageContracts = contracts.filter(contract => contract.page === page && (contract.framework ?? framework) === framework)
        const expected = await Promise.all(pageContracts.map(async contract => ({
          label: contract.label,
          language: contract.verification === "json" ? "json" : "ts",
          source: normalize(await readFile(resolve(fixturesRoot, contract.fixture), "utf8")),
        })))
        const json = (list: typeof blocks) => list.filter(block => block.language === "json").sort(compareBlocks)

        expect(blocks, `${page} (${framework}) should show every fixture`).toEqual(expect.arrayContaining(expected))
        expect(json(expected), `${page} (${framework}) should source every JSON block from a fixture`).toEqual(json(blocks))
      }
    }
  })

  it("keeps shell commands out of source fixtures", async () => {
    const contracts = await readContracts()

    expect(contracts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringMatching(/terminal|command/i) }),
    ]))
  })
})

function compareBlocks(left: { label: string, source: string }, right: { label: string, source: string }) {
  return left.label.localeCompare(right.label) || left.source.localeCompare(right.source)
}
