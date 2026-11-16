// The Realtime client for the presence browser test. The test sets the people in the room with
// `window.vitehubTestPresence(people)`, and `window.vitehubTestRoomJoined` turns true once the overlay joins.
import type { RealtimeRoom } from "@vite-hub/realtime/client"

type RealtimePerson = ReturnType<RealtimeRoom["people"]>[number]

declare global {
  interface Window {
    vitehubTestPresence: (people: RealtimePerson[]) => void
    vitehubTestRoomJoined: boolean
  }
}

const listeners = new Set<() => void>()
let people: RealtimePerson[] = []
window.vitehubTestRoomJoined = false
window.vitehubTestPresence = (next) => {
  people = next
  for (const listener of listeners) listener()
}

export function connectRealtimeRoom(): Pick<RealtimeRoom, "clientId" | "people" | "states" | "status" | "setLocal" | "onUpdate" | "destroy"> {
  window.vitehubTestRoomJoined = true
  return {
    clientId: 1,
    people: () => people,
    states: () => new Map(),
    status: () => "connected",
    setLocal() {},
    onUpdate(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    destroy() {},
  }
}
