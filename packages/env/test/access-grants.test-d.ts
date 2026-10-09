import { describe, expectTypeOf, it } from "vitest"

import { createEnvAuthenticator } from "../src/auth.ts"
import type { EnvAccessContext, EnvBridge, EnvBridgeOptions } from "../src/bridge.ts"
import type { LoadServerEnvOptions } from "../src/types.ts"

declare const bridge: EnvBridge
declare const granted: EnvAccessContext
declare const options: Omit<EnvBridgeOptions, "runtimeActor">
const actor = { kind: "user", id: "owner" } as const

describe("Env access grants", () => {
  it("accepts only contexts that Env created", () => {
    expectTypeOf(createEnvAuthenticator).returns.toEqualTypeOf<(request: Request) => Promise<EnvAccessContext | null>>()
    void bridge.grants(granted, "token")
    const load: LoadServerEnvOptions = { access: granted }
    void load
    expectTypeOf<EnvAccessContext["actor"]>().toEqualTypeOf<Readonly<{ id: string, kind: "user" | "agent" | "service" }>>()
  })

  it("rejects contexts that application code builds", () => {
    // @ts-expect-error Only Env creates administrator contexts.
    void bridge.grants({ actor, admin: true }, "token")
    // @ts-expect-error Only Env creates actor contexts. A literal cannot claim the grants of an actor.
    void bridge.use({ actor: { kind: "agent", id: "other" } }, "token", "call", () => undefined)
    // @ts-expect-error A verified token scope also needs a context from Env.
    void bridge.inspect({ actor, scope: [{ key: "token", permissions: ["inspect"] }] }, "token")
    // @ts-expect-error Server Env loads need a context from Env.
    const load: LoadServerEnvOptions = { access: { actor } }
    // @ts-expect-error The runtime has one fixed actor. It cannot return a context for each call.
    void ({ ...options, runtimeContext: () => granted } satisfies EnvBridgeOptions)
    // @ts-expect-error Env contexts are frozen.
    granted.actor = actor
    void load
  })
})
