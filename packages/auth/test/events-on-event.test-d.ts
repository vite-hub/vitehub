import { expectTypeOf, it } from "vitest"
import { defineAuth } from "../src/index.ts"
import type { AuthEvent, AuthEventStore, AuthEventType } from "../src/index.ts"

declare const store: AuthEventStore

it("gives onEvent an AuthEvent whose type narrows", () => {
  defineAuth({
    events: {
      store,
      onEvent(event) {
        expectTypeOf(event).toEqualTypeOf<AuthEvent>()
        expectTypeOf(event.type).toEqualTypeOf<AuthEventType>()
        expectTypeOf(event.type).not.toEqualTypeOf<string>()
        if (event.type === "user.role_changed") expectTypeOf(event.type).toEqualTypeOf<"user.role_changed">()
        else expectTypeOf(event.type).toEqualTypeOf<Exclude<AuthEventType, "user.role_changed">>()
        switch (event.type) {
          case "user.signed_in":
          case "user.signed_up":
            expectTypeOf(event.type).toEqualTypeOf<"user.signed_in" | "user.signed_up">()
            break
        }
      },
    },
  })
  defineAuth({ events: { store, onEvent: async () => {} } })
  // @ts-expect-error onEvent is a callback, not a URL.
  defineAuth({ events: { store, onEvent: "https://example.com/hook" } })
})
