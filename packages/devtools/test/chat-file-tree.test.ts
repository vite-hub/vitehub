import { describe, expect, it } from "vitest"

import type { ChatDevtoolsFileTreeItem } from "../src/chat-shared.ts"
import { flattenFiles, sourceRootStates, syncExpandedFilePaths } from "../devtools/chat/app/file-tree.ts"

function directory(path: string, children: ChatDevtoolsFileTreeItem[] = []): ChatDevtoolsFileTreeItem {
  return { children, kind: "directory", path }
}

function file(path: string): ChatDevtoolsFileTreeItem {
  return { kind: "file", path }
}

describe("chat file tree", () => {
  it("keeps workspace folders collapsed by default", () => {
    const files = [
      directory("forecasting-engine", [file("forecasting-engine/README.md")]),
      directory("ingestion", [file("ingestion/README.md")]),
      directory("instructions", [file("instructions/AGENTS.md")]),
    ]

    const expanded = syncExpandedFilePaths(files, new Set())

    expect([...expanded]).toEqual([])
    expect(flattenFiles(files, expanded).map(row => row.path)).toEqual([
      "forecasting-engine",
      "ingestion",
      "instructions",
    ])
  })

  it("opens materialized source folders when children arrive", () => {
    const files = [
      { ...directory("forecasting-engine", [file("forecasting-engine/README.md")]), source: "forecasting-engine", status: "ready" as const },
      { ...directory("ingestion", [file("ingestion/README.md")]), source: "ingestion", status: "ready" as const },
      directory("instructions", [file("instructions/AGENTS.md")]),
    ]

    const expanded = syncExpandedFilePaths(files, new Set(), new Map([
      ["forecasting-engine", "lazy"],
      ["ingestion", "lazy"],
    ]))

    expect([...expanded]).toEqual(["forecasting-engine", "ingestion"])
    expect(flattenFiles(files, expanded).map(row => row.path)).toEqual([
      "forecasting-engine",
      "forecasting-engine/README.md",
      "ingestion",
      "ingestion/README.md",
      "instructions",
    ])
  })

  it("does not recursively open nested materialized source folders", () => {
    const files = [
      {
        ...directory("ingestion", [
          { ...directory("ingestion/customers", [file("ingestion/customers/acme.csv")]), source: "ingestion" },
        ]),
        source: "ingestion",
        status: "ready" as const,
      },
    ]

    const expanded = syncExpandedFilePaths(files, new Set(), new Map([["ingestion", "lazy"]]))

    expect([...expanded]).toEqual(["ingestion"])
    expect(flattenFiles(files, expanded).map(row => row.path)).toEqual([
      "ingestion",
      "ingestion/customers",
    ])
  })

  it("preserves manual source root collapse after auto-opening it", () => {
    const files = [
      { ...directory("ingestion", [file("ingestion/README.md")]), source: "ingestion", status: "ready" as const },
    ]
    const expanded = syncExpandedFilePaths(files, new Set(), new Map([["ingestion", "lazy"]]))
    const collapsed = syncExpandedFilePaths(files, new Set(), sourceRootStates(files))

    expect([...expanded]).toEqual(["ingestion"])
    expect([...collapsed]).toEqual([])
  })

  it("opens a single synthetic root without recursively expanding workspace folders", () => {
    const files = [
      directory("", [
        directory("forecasting-engine", [file("forecasting-engine/README.md")]),
        directory("ingestion", [file("ingestion/README.md")]),
      ]),
    ]

    const expanded = syncExpandedFilePaths(files, new Set())

    expect([...expanded]).toEqual([""])
    expect(flattenFiles(files, expanded).map(row => [row.path, row.depth, row.expanded])).toEqual([
      ["", 0, true],
      ["forecasting-engine", 1, false],
      ["ingestion", 1, false],
    ])
  })

  it("preserves explicit folder toggles across metadata refreshes", () => {
    const files = [
      directory("forecasting-engine", [file("forecasting-engine/README.md")]),
      directory("ingestion", [file("ingestion/README.md")]),
    ]

    const expanded = syncExpandedFilePaths(files, new Set(["ingestion"]))

    expect([...expanded]).toEqual(["ingestion"])
    expect(flattenFiles(files, expanded).map(row => row.path)).toEqual([
      "forecasting-engine",
      "ingestion",
      "ingestion/README.md",
    ])
  })
})
