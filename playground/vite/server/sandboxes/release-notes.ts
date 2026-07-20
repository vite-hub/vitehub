import { defineSandbox } from "@vite-hub/sandbox"

type ReleaseNotesPayload = {
  notes: string
}

type ReleaseNotesResult = {
  items: string[]
  summary: string
}

export default defineSandbox({
  async run({ notes }: ReleaseNotesPayload): Promise<ReleaseNotesResult> {
    const items = notes
      .split("\n")
      .map(note => note.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean)

    return {
      items,
      summary: items[0] || "",
    }
  },
})
