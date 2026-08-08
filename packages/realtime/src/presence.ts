import type { RealtimePerson } from "./types.ts"

export type RealtimeIdentity = Omit<RealtimePerson, "clientId">

const personColors = ["#E11D48", "#D97706", "#059669", "#0891B2", "#2563EB", "#7C3AED", "#C026D3"]

export function createRealtimeIdentity(user: Record<string, unknown> & { id: string }): RealtimeIdentity {
  if (!user.id || user.id.length > 256) throw new TypeError("Realtime identity requires a valid user id.")
  let hash = 0
  for (let index = 0; index < user.id.length; index++) hash = Math.imul(31, hash) + user.id.charCodeAt(index) | 0
  const name = (typeof user.name === "string" && user.name || typeof user.email === "string" && user.email || "Anonymous").slice(0, 256)
  return {
    color: personColors[Math.abs(hash) % personColors.length]!,
    id: user.id,
    ...(typeof user.image === "string" && user.image && user.image.length <= 2048 ? { image: user.image } : {}),
    name,
  }
}

function isRealtimeIdentity(value: unknown): value is RealtimeIdentity {
  if (!value || typeof value !== "object") return false
  const person = value as Record<string, unknown>
  return typeof person.id === "string" && person.id.length > 0 && person.id.length <= 256
    && typeof person.name === "string" && person.name.length > 0 && person.name.length <= 256
    && typeof person.color === "string" && /^#[\da-f]{6}$/i.test(person.color)
    && (person.image === undefined || typeof person.image === "string" && person.image.length <= 2048)
}

export function getRealtimePeople(states: Map<number, Record<string, unknown>>): RealtimePerson[] {
  const people: RealtimePerson[] = []
  for (const [clientId, state] of states) {
    if (isRealtimeIdentity(state.user)) people.push({ ...state.user, clientId })
  }
  return people
}
