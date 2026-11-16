import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect, it } from "vitest"

import { readDiagnosticCatalogs } from "../docs/modules/diagnostics/catalog.ts"

import type { DiagnosticCode } from "../docs/modules/diagnostics/catalog.ts"

// Concurrent pull requests that append the next number, such as AUTH_C0067, edit the same lines of a catalog and of
// its docs page, and can take the same code. A named code in alphabetical order lands at a line of its own.
const repoRoot = resolve(import.meta.dirname, "..")
const legacyFile = "test/fixtures/legacy-diagnostic-codes.txt"
const legacy = new Set(readFileSync(join(repoRoot, legacyFile), "utf8").split("\n").filter(line => line && !line.startsWith("#")))
const catalogs = readDiagnosticCatalogs(repoRoot)
const numbered = /_[A-Z]\d{4}$/

function isNew(code: DiagnosticCode): boolean {
  return !legacy.has(code.code)
}

function at(file: string, line: number): string {
  return `${file}:${line}`
}

it("keeps the list of legacy codes closed", () => {
  // The list only shrinks. A new code is named and sorted, so it never needs an entry.
  expect(legacy.size, `${legacyFile} never grows. Remove the codes that you added to it, and name the new codes instead.`).toBeLessThanOrEqual(2402)
})

it("names every new diagnostic code", () => {
  const found = catalogs.flatMap(catalog => catalog.codes.filter(code => isNew(code) && numbered.test(code.code)).map((code) => {
    const prefix = code.code.replace(numbered, "")
    return `${code.code} (${at(catalog.file, code.line)}) is a new numbered code. Name it ${prefix}_<WHAT_FAILED>, such as ${prefix}_ROUTE_INVALID, and put it in alphabetical order. Do not add it to ${legacyFile}.`
  }))
  expect(found).toEqual([])
})

it("puts every new code in alphabetical order in its catalog group", () => {
  const found: string[] = []
  for (const catalog of catalogs) {
    // A group comment, such as `// Runtime errors`, starts a group. Sort a new code among the codes of its group.
    const groups: DiagnosticCode[][] = []
    for (const [index, code] of catalog.codes.entries()) {
      if (index === 0 || code.group !== catalog.codes[index - 1]!.group) groups.push([])
      groups.at(-1)!.push(code)
    }
    for (const group of groups) {
      for (const [index, code] of group.entries()) {
        // A new numbered code fails the naming check first.
        if (!isNew(code) || numbered.test(code.code)) continue
        const before = group[index - 1]?.code
        const after = group[index + 1]?.code
        if ((before === undefined || before < code.code) && (after === undefined || code.code < after)) continue
        found.push(`${code.code} (${at(catalog.file, code.line)}) is not in alphabetical order. ${placement(group.filter(other => other !== code).map(other => other.code), code.code, index)}`)
      }
    }
  }
  expect(found).toEqual([])
})

/** The position in the group nearest to `index` where `code` sorts between its neighbors. One always exists. */
function placement(others: string[], code: string, index: number): string {
  const fits = (position: number) => (position === 0 || others[position - 1]! < code) && (position === others.length || code < others[position]!)
  const positions = Array.from({ length: others.length + 1 }, (_, position) => position).filter(fits)
  const position = positions.sort((left, right) => Math.abs(left - index) - Math.abs(right - index))[0]!
  return position === 0 ? `Move it before ${others[0]}.` : `Move it to just after ${others[position - 1]}.`
}

it("declares every new code in one catalog", () => {
  const declarations = new Map<string, string[]>()
  for (const catalog of catalogs) {
    for (const code of catalog.codes.filter(isNew)) declarations.set(code.code, [...declarations.get(code.code) ?? [], at(catalog.file, code.line)])
  }
  const found = [...declarations].filter(([, places]) => places.length > 1).map(([code, places]) => `${code} is declared in ${places.join(" and ")}. Keep one declaration, or give the other failure a name of its own.`)
  expect(found).toEqual([])
})

it("documents new codes on their generated pages, not on the limits-and-errors pages", () => {
  const added = new Set(catalogs.flatMap(catalog => catalog.codes.filter(isNew).map(code => code.code)))
  const docs = join(repoRoot, "docs/content/docs")
  const found: string[] = []
  for (const section of readdirSync(docs)) {
    const file = join(docs, section, "limits-and-errors.md")
    if (!existsSync(file)) continue
    for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
      // A table row lists codes in its first cell. A heading names one code.
      const cell = /^\|([^|]*)\|/.exec(line)?.[1] ?? /^#{2,4}\s+(.*)$/.exec(line)?.[1] ?? ""
      for (const code of cell.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []) {
        if (added.has(code)) found.push(`docs/content/docs/${section}/limits-and-errors.md:${index + 1} lists the new code ${code}. Remove it: the docs build writes a page for each code from the \`why\` and \`fix\` of its catalog entry. Write more in docs/diagnostics/${code}.md, which replaces the body of that page.`)
      }
    }
  }
  expect(found).toEqual([])
})
