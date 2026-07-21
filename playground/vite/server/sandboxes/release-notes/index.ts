import { readFile } from "node:fs/promises"

export type SandboxPayload = {
  notes: string
}

type ReleaseNotesResult = {
  items: string[]
  summary: string
}

const { payload } = JSON.parse(await readFile(process.argv[2], "utf8")) as {
  payload?: SandboxPayload
}

if (!payload) throw new TypeError("Release notes require a payload.")

const items = payload.notes
  .split("\n")
  .map((note) => note.replace(/^[-*]\s*/, "").trim())
  .filter(Boolean)

export default {
  items,
  summary: items[0] || "",
} satisfies ReleaseNotesResult
