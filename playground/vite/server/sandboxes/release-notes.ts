import { defineSandbox } from "@vitehub/sandbox"

type ReleaseNotesPayload = {
  notes: string
}

type ReleaseNotesResult = {
  items: string[]
  summary: string
}

export default defineSandbox<ReleaseNotesPayload, ReleaseNotesResult>(async ({ notes }) => {
  const items = notes
    .split("\n")
    .map(note => note.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)

  return {
    items,
    summary: items[0] || "",
  }
})
