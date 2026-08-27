import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"
import { array, object, parse, picklist, string } from "valibot"

const docsRoot = resolve(import.meta.dirname, "..")
const fixturesRoot = resolve(import.meta.dirname, "../../fixtures/docs-hosts")

const snippetContractsSchema = array(object({
  fixture: string(),
  label: string(),
  page: string(),
  verification: picklist(["build", "json", "typecheck"]),
}))

function normalize(source: string) {
  return source.trim().replaceAll("\r\n", "\n")
}

function sourceBlocks(source: string) {
  return [...source.matchAll(/```(ts|json) \[([^\]]+)\]\n([\s\S]*?)\n```/g)].map(match => ({
    label: match[2]!,
    source: normalize(match[3]!),
  }))
}

async function readContracts() {
  return parse(snippetContractsSchema, JSON.parse(await readFile(resolve(fixturesRoot, "manifest.json"), "utf8")))
}

describe("launch-critical documentation snippets", () => {
  it("sources every TypeScript and JSON block from an executable fixture", async () => {
    const contracts = await readContracts()
    const pages = [...new Set(contracts.map(contract => contract.page))]

    expect(contracts).toHaveLength(18)

    for (const page of pages) {
      const blocks = sourceBlocks(await readFile(resolve(docsRoot, "content/docs", page), "utf8"))
      const pageContracts = contracts.filter(contract => contract.page === page)
      const expected = await Promise.all(pageContracts.map(async contract => ({
        label: contract.label,
        source: normalize(await readFile(resolve(fixturesRoot, contract.fixture), "utf8")),
      })))

      expect(expected.sort(compareBlocks), `${page} should inventory every source block`).toEqual(blocks.sort(compareBlocks))
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
