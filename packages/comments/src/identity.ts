import type { CommentAuthor, CommentsUser } from "./types.ts"

/** A non-empty string, or undefined. User records come from apps and Auth, so their fields are untrusted. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The author that a comment keeps for a user: the name, else the email, else "Someone", and the image. */
export function authorOf(user: CommentsUser): CommentAuthor {
  const author: CommentAuthor = { id: user.id, name: (text(user.name) ?? text(user.email) ?? "Someone").slice(0, 256) }
  const image = text(user.image)
  if (image) author.image = image
  if (user.guest === true) author.guest = true
  return author
}

/** The guest that the overlay names in its request headers after a person without an account types a name. */
export function guestFromHeaders(headers: Headers): CommentAuthor | undefined {
  const id = headers.get("x-vitehub-comments-guest-id")
  const name = headers.get("x-vitehub-comments-guest-name")
  if (!id || !name || id.length > 64) return
  try {
    const decoded = decodeURIComponent(name).trim().slice(0, 64)
    return decoded ? { id: `guest:${id}`, name: decoded, guest: true } : undefined
  }
  catch {
    return undefined
  }
}
