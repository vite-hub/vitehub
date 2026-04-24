import { defineSandbox } from "@vitehub/sandbox"

export default defineSandbox(async (payload?: { notes?: string }) => {
  const notes = typeof payload?.notes === "string" ? payload.notes.trim() : ""
  const items = notes
    .split(/\n+/)
    .map(line => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)

  return {
    summary: items[0] || "No notes provided.",
    items: items.slice(0, 3),
  }
})
