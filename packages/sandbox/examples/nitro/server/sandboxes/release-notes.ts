import { defineSandbox } from "@vitehub/sandbox"

export type ReleaseNotesPayload = {
  notes?: string
}

export type ReleaseNotesResult = {
  summary: string
  items: string[]
}

export default defineSandbox(async (payload: ReleaseNotesPayload = {}): Promise<ReleaseNotesResult> => {
  const items = (payload.notes || "")
    .split("\n")
    .map(note => note.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)

  return {
    summary: items[0] || "",
    items,
  }
})
