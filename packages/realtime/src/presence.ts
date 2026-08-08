import type { RealtimePerson } from "./types.ts"

export type RealtimeIdentity = Omit<RealtimePerson, "clientId">

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
