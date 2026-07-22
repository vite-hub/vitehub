type SandboxPayload = {
  notes: string
}

type ReleaseNotesResult = {
  items: string[]
  summary: string
}

export default async function releaseNotes(payload: SandboxPayload): Promise<ReleaseNotesResult> {
  const items = payload.notes
    .split("\n")
    .map(note => note.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)

  return {
    items,
    summary: items[0] || "",
  }
}
