import type { H3Event } from "h3"
import { describe, expectTypeOf, it } from "vitest"

import type { Result } from "@vite-hub/runtime"

import type { RealtimeAuthorizeContext, RealtimeCheckpoint, RealtimeRequestContext, RealtimeRequestErrorCode, RealtimeSaved } from "../src/index.ts"
import type { RealtimeCaretUser } from "../src/vue.ts"
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
  it("gives identify() and authorize() the H3 event of the request", () => {
    expectTypeOf<RealtimeRequestContext["event"]>().toEqualTypeOf<H3Event>()
    expectTypeOf<RealtimeAuthorizeContext["event"]>().toEqualTypeOf<H3Event>()
  })
})
