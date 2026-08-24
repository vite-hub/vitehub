import { isPlainObject } from "@vite-hub/internal/object"

import type { RealtimePerson } from "./types.ts"

export type RealtimeIdentity = Omit<RealtimePerson, "clientId">

const personColors = ["#E11D48", "#D97706", "#059669", "#0891B2", "#2563EB", "#7C3AED", "#C026D3"]

function isString(value: unknown): value is string {
  try {
    return String(value) === value
  }
  catch {
    return false
  }
}

export function createRealtimeIdentity(user: Record<string, unknown> & { id: string }): RealtimeIdentity {
  if (!isString(user.id) || !user.id || user.id.length > 256) {
    throw new TypeError("Realtime identity requires a valid user id.")
  }
  let hash = 0
  for (let index = 0; index < user.id.length; index++) hash = Math.imul(31, hash) + user.id.charCodeAt(index) | 0
  const name = (isString(user.name) && user.name || isString(user.email) && user.email || "Anonymous").slice(0, 256)
  const identity: RealtimeIdentity = {
    color: personColors[Math.abs(hash) % personColors.length]!,
    id: user.id,
    name,
  }
  if (isString(user.image) && user.image && user.image.length <= 2048) identity.image = user.image
  return identity
}

function isRealtimeIdentity(value: unknown): value is RealtimeIdentity {
  if (!isPlainObject(value)) return false
  return isString(value.id) && value.id.length > 0 && value.id.length <= 256
    && isString(value.name) && value.name.length > 0 && value.name.length <= 256
    && isString(value.color) && /^#[\da-f]{6}$/i.test(value.color)
    && (value.image === undefined || isString(value.image) && value.image.length <= 2048)
}

export function getRealtimePeople(states: Map<number, Record<string, unknown>>): RealtimePerson[] {
  const people: RealtimePerson[] = []
  for (const [clientId, state] of states) {
    if (isRealtimeIdentity(state.user)) {
      const { color, id, image, name } = state.user
      const person: RealtimePerson = { color, id, name, clientId }
      if (image !== undefined) person.image = image
      people.push(person)
    }
  }
  return people
}
