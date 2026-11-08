/** Escapes text for HTML content and quoted attribute values. Server side only. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === "\"" ? "&quot;" : "&#39;")
}

/** The escaped first letter of a name, for an avatar. */
export function initialHtml(name: string): string {
  return escapeHtml((name.trim().charAt(0) || "?").toUpperCase())
}
