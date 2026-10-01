import { describe, expectTypeOf, it } from "vitest"

import { gmail } from "../src/google.ts"
import { defineConnection, oauth2, useConnection } from "../src/index.ts"

import type { GmailLabel, GmailProfile } from "../src/google.ts"
import type { ConnectionCallResult, ConnectionClient, ConnectionName, ConnectionOperation, ConnectionSkipped } from "../src/index.ts"

interface Output { id: string }

declare const readOperation: ConnectionOperation<{ id: string }, Output, "read">
declare const writeOperation: ConnectionOperation<{ name: string }, Output, "write">

describe("types", () => {
  it("types dry-run call results", () => {
    expectTypeOf<ConnectionCallResult<Output, "write", true>>().toEqualTypeOf<ConnectionSkipped>()
    expectTypeOf<ConnectionCallResult<Output, "write", false>>().toEqualTypeOf<Output>()
    expectTypeOf<ConnectionCallResult<Output, "write", undefined>>().toEqualTypeOf<Output>()
    expectTypeOf<ConnectionCallResult<Output, "write", boolean>>().toEqualTypeOf<Output | ConnectionSkipped>()
    expectTypeOf<ConnectionCallResult<Output, "write", boolean | undefined>>().toEqualTypeOf<Output | ConnectionSkipped>()
    expectTypeOf<ConnectionCallResult<Output, "read", true>>().toEqualTypeOf<Output>()
    expectTypeOf<ConnectionCallResult<Output, "read", boolean>>().toEqualTypeOf<Output>()
    expectTypeOf<ConnectionSkipped["skipped"]>().toEqualTypeOf<"dry-run">()
  })

  it("infers dry run from useConnection options", () => {
    const live = useConnection("gmail")
    const dry = useConnection("gmail", { dryRun: true })
    const explicitLive = useConnection("gmail", { dryRun: false })

    expectTypeOf(live).toEqualTypeOf<ConnectionClient<undefined>>()
    expectTypeOf(dry).toEqualTypeOf<ConnectionClient<true>>()
    expectTypeOf(live.call(writeOperation, { name: "x" })).resolves.toEqualTypeOf<Output>()
    expectTypeOf(explicitLive.call(writeOperation, { name: "x" })).resolves.toEqualTypeOf<Output>()
    expectTypeOf(dry.call(writeOperation, { name: "x" })).resolves.toEqualTypeOf<ConnectionSkipped>()
    expectTypeOf(dry.call(readOperation, { id: "1" })).resolves.toEqualTypeOf<Output>()

    // @ts-expect-error Operation input is checked.
    live.call(readOperation, { name: "x" })
  })

  it("keeps dry-run typing through the Gmail client", () => {
    const dry = gmail(useConnection("gmail", { dryRun: true }))
    const live = gmail(useConnection("gmail"))

    expectTypeOf(dry.labels.create({ name: "Receipts" })).resolves.toEqualTypeOf<ConnectionSkipped>()
    expectTypeOf(live.labels.create({ name: "Receipts" })).resolves.toEqualTypeOf<GmailLabel>()
    expectTypeOf(dry.profile.get()).resolves.toEqualTypeOf<GmailProfile>()
    expectTypeOf(live.labels.list).parameters.toEqualTypeOf<[]>()

    // @ts-expect-error Gmail inputs are typed.
    live.messages.get({ messageId: "1" })
  })

  it("accepts any Connection name before discovery generates types", () => {
    expectTypeOf<ConnectionName>().toEqualTypeOf<string>()
    const runtimeName: string = "runtime-connection"
    useConnection(runtimeName)
  })

  it("keeps the provider type of a definition", () => {
    const provider = oauth2({ authorizationUrl: "https://a.example", client: () => ({ clientId: "id" }), origins: ["https://api.a.example"], scopes: ["s"], tokenUrl: "https://a.example/token" })
    const definition = defineConnection({ access: { server: { allow: ["*"] } }, provider })
    expectTypeOf(definition.provider).toEqualTypeOf(provider)

    // @ts-expect-error Access patterns are string lists.
    defineConnection({ access: { server: { allow: "*" } }, provider })
  })
})
