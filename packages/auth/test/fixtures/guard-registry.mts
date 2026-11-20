import { apiKey } from "@better-auth/api-key"
import { defineAuth } from "@vite-hub/auth"
import { requireAuth, requireAuthorization, requireCaller, withAnonymousAuthorization, withAuth, withAuthorization } from "@vite-hub/auth/server"
import { expectTypeOf } from "vitest"

const registeredDefinition = defineAuth({
  plugins: [apiKey({ enableSessionForAPIKeys: true })],
  session: { additionalFields: { region: { type: "string", required: true, defaultValue: "local" } } },
  user: { additionalFields: { team: { type: "string", required: true } } },
})

declare global {
  namespace ViteHub {
    interface AuthRegistry {
      definition: typeof registeredDefinition
    }
  }
}

const explicit = defineAuth({ database: "memory" })
declare const optional: typeof explicit | undefined
const request = new Request("https://app.example.com/me")

const registered = await requireAuth(request)
expectTypeOf(registered.user.team).toEqualTypeOf<string>()
expectTypeOf(registered.session.region).toEqualTypeOf<string | undefined>()
expectTypeOf(registered.session.userId).toEqualTypeOf<string>()

const checked = await requireAuth(request, explicit)
expectTypeOf(checked.user.email).toEqualTypeOf<string>()
expectTypeOf(checked.user).not.toHaveProperty("team")
expectTypeOf(checked.session).not.toHaveProperty("region")
expectTypeOf((await requireAuth(request, optional)).user).not.toHaveProperty("team")
expectTypeOf((await requireAuthorization(request, true, explicit)).user).not.toHaveProperty("team")
withAuth((_input, { user }) => expectTypeOf(user).not.toHaveProperty("team"), explicit)
withAuthorization(true, (_input, { user }) => expectTypeOf(user).not.toHaveProperty("team"), explicit)
withAnonymousAuthorization(() => true, (_input, { user }) => {
  if (user) expectTypeOf(user).not.toHaveProperty("team")
}, explicit)
withAuth((_input, { user }) => expectTypeOf(user.team).toEqualTypeOf<string>())

const [, caller] = await requireCaller(request, explicit)
if (caller?.kind === "browser") expectTypeOf(caller.session).not.toHaveProperty("region")
const [, defaultCaller] = await requireCaller(request)
if (defaultCaller?.kind === "browser") expectTypeOf(defaultCaller.session.region).toEqualTypeOf<string | undefined>()
