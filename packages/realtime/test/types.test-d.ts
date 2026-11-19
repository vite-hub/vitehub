import type { H3Event } from "h3"
import { describe, expectTypeOf, it } from "vitest"

import type { Result, ViteHubContext } from "@vite-hub/runtime"
import type {} from "@vite-hub/runtime/internal/h3"

import type { RealtimeAuthorizeContext, RealtimeCheckpoint, RealtimeRequestContext, RealtimeRequestErrorCode, RealtimeRequestEvent, RealtimeRoomRequestErrorCode, RealtimeSaved } from "../src/index.ts"
import { requestRealtimeRoom } from "../src/server.ts"
import type { RealtimeCaretUser } from "../src/vue.ts"
import { defineRealtime } from "../src/index.ts"
import { useRealtimeTiptap } from "../src/vue.ts"

declare const realtime: ReturnType<typeof useRealtimeTiptap>

describe("realtime client result types", () => {
  it("types the codes of each request method", () => {
    expectTypeOf<RealtimeRequestErrorCode>().toEqualTypeOf<
      | "REALTIME_DISABLED"
      | "REALTIME_DISCONNECTED"
      | "REALTIME_INVALID_RESPONSE"
      | "REALTIME_MISSING_DOCUMENT"
      | "REALTIME_REQUEST_FAILED"
    >()
    expectTypeOf(realtime.save).returns.toEqualTypeOf<Promise<Result<RealtimeSaved, RealtimeRequestErrorCode>>>()
    expectTypeOf(realtime.history.checkpoint).returns.toEqualTypeOf<Promise<Result<RealtimeCheckpoint, RealtimeRequestErrorCode>>>()
    expectTypeOf(realtime.refresh).returns.toEqualTypeOf<Promise<Result<{ digest: string | null, reseeded: boolean }, RealtimeRequestErrorCode>>>()
  })

  it("narrows a checkpoint result by the error element", async () => {
    const [error, checkpoint] = await realtime.history.checkpoint()
    if (error) {
      expectTypeOf(error.code).toEqualTypeOf<RealtimeRequestErrorCode>()
      expectTypeOf(checkpoint).toEqualTypeOf<undefined>()
      // @ts-expect-error A room error goes into the WebSocket stream, not into the request tuple.
      void (error.code === "REALTIME_DOCUMENT_TOO_LARGE")
      return
    }
    expectTypeOf(checkpoint).toEqualTypeOf<RealtimeCheckpoint>()
  })
})

describe("room request result types", () => {
  it("types the codes that requestRealtimeRoom() returns", () => {
    expectTypeOf<RealtimeRoomRequestErrorCode>().toEqualTypeOf<
      | "REALTIME_ROOM_ABORTED"
      | "REALTIME_ROOM_CROWDED"
      | "REALTIME_ROOM_ELSEWHERE"
      | "REALTIME_ROOM_EMPTY"
      | "REALTIME_ROOM_REFUSED"
      | "REALTIME_ROOM_REQUESTS_OFF"
      | "REALTIME_ROOM_TIMEOUT"
    >()
    expectTypeOf(requestRealtimeRoom).returns.resolves.toEqualTypeOf<Result<unknown, RealtimeRoomRequestErrorCode>>()
  })
})

describe("realtime caret types", () => {
  it("infers the person in the caret options", () => {
    type Carets = NonNullable<Parameters<typeof useRealtimeTiptap>[2]>["carets"]
    const carets: Carets = {
      render: (user) => {
        expectTypeOf(user).toEqualTypeOf<RealtimeCaretUser>()
        return document.createElement("span")
      },
      selectionRender: user => ({ style: `background-color: ${user.color}` }),
    }
    void carets
    // @ts-expect-error A caret is an element, not markup.
    const markup: Carets = { render: (user: RealtimeCaretUser) => `<span>${user.name}</span>` }
    void markup
  })
})

describe("realtime definition types", () => {
  it("gives identify(), origins(), and authorize() the H3 event of the request, with Standard Context", () => {
    expectTypeOf<RealtimeRequestContext["event"]>().toExtend<H3Event>()
    expectTypeOf<RealtimeAuthorizeContext["event"]>().toEqualTypeOf<RealtimeRequestEvent>()
    expectTypeOf<RealtimeRequestEvent["~standard"]["req"]>().toEqualTypeOf<Request>()
    expectTypeOf<RealtimeRequestEvent>().toExtend<ViteHubContext>()
    // An app's access helpers take the H3 event, as Drop's presence checks do.
    const findMember = (event: H3Event, request: Request) => event.context.member === request.headers.get("x-member")
    defineRealtime({
      document: false,
      origins: ({ event, request }) => findMember(event, request),
      identify: ({ event, request }) => findMember(event, request) ? { id: "maxi" } : null,
      authorize: ({ event, request }) => findMember(event, request),
    })
  })

  it("leaves document options out of a definition without a document", () => {
    defineRealtime({ authorize: true, document: false })
    // @ts-expect-error A room without a document never saves.
    defineRealtime({ authorize: true, document: false, persistence: false })
    // @ts-expect-error A room without a document has no history.
    defineRealtime({ authorize: true, document: false, history: { checkpoint: true } })
  })

  it("requires one access rule", () => {
    defineRealtime({ authorize: true, document: { workspace: "docs" } })
    defineRealtime({ authorize: ({ mode }) => mode === "read", document: { workspace: "docs" } })
    defineRealtime({ authorize: ({ user }) => user?.id === "ana", document: false })
    defineRealtime({ access: "public", document: { workspace: "docs" }, identify: () => null })
    // @ts-expect-error A definition must say who can read and write its rooms.
    defineRealtime({ document: { workspace: "docs" } })
    // @ts-expect-error identify() alone lets anonymous users in, so it is not an access rule.
    defineRealtime({ document: false, identify: () => null })
    // @ts-expect-error Public rooms have no other access rule.
    defineRealtime({ access: "public", authorize: true, document: false })
    // @ts-expect-error `authorize: true` replaced `auth: true`.
    defineRealtime({ auth: true, document: false })
    // @ts-expect-error Public rooms have no other access rule.
    defineRealtime({ access: "public", authorize: () => true, document: false })
    // @ts-expect-error authorize() returns true to allow; a path that returns nothing would deny.
    defineRealtime({ authorize: ({ mode }) => { if (mode === "write") return true }, document: false })
  })
})
