/** The variable that lists who may comment on the Console's own pages, as emails, comma-separated. */
export const commentersVariable = "VITEHUB_CONSOLE_COMMENTERS"

/**
 * Whether a person may comment on the Console's pages. Anyone can sign up to a Console, so a signed-in account is not
 * enough: the person's email must be in `VITEHUB_CONSOLE_COMMENTERS`. The same check covers the overlay, where the
 * person is the Console account of the browser, and calls from a Console that linked this one, where the person is the
 * one that Console signed. Without the variable, nobody may.
 */
export function mayComment(user: object | null, commenters: string | undefined): boolean {
  const value: unknown = user ? Reflect.get(user, "email") : undefined
  if (typeof value !== "string" || !value) return false
  const email = value.toLowerCase()
  if (email.endsWith("@passkey.invalid")) return false
  return (commenters ?? "").split(",").some(entry => entry.trim().toLowerCase() === email)
}
