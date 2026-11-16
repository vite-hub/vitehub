import { testUtils } from "better-auth/plugins"

import { authForRequest, resolveDefaultDefinition } from "./auth-instance.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { Session, User } from "better-auth"
import type { AuthDefinition } from "./types.ts"

/** The user to sign in. Auth creates it when no user has this email. Other fields, such as `role`, go to the new user. */
export interface SignInTestUser {
  email?: string
  name?: string
  [field: string]: unknown
}

/** A signed-in session for app tests. */
export interface TestSignIn {
  /** The `cookie` header of the session, such as `better-auth.session_token=…`. */
  cookie: string
  /** Headers with the session cookie. Pass them to a `Request` so that `requireAuth()` accepts it. */
  headers: Headers
  session: Session
  user: User
}

/**
 * Signs in a user of the app's Auth Definition and returns the session cookie. It writes the user and the session to the
 * Auth database, as a real sign-in does, so `requireAuth()`, `useAuth().api.getSession()`, and abilities accept the
 * request. It sends no email and calls no provider. A Definition with the `stateless()` preset has no database, so it
 * fails with `AUTH_TEST_SIGN_IN_STATELESS`.
 */
export async function signIn(user: SignInTestUser = {}, definition: AuthDefinition = resolveDefaultDefinition()): Promise<TestSignIn> {
  const context = await authForRequest(new Request("http://localhost/"), undefined, definition).$context
  if (!context.options.database) throw authErrorDiagnostics.AUTH_TEST_SIGN_IN_STATELESS()
  const helpers = testUtils().init(context).context.test
  const existing = user.email ? await context.internalAdapter.findUserByEmail(user.email) : null
  const saved = existing?.user ?? await helpers.saveUser(helpers.createUser(user))
  const { headers, session } = await helpers.login({ userId: saved.id })
  return { cookie: headers.get("cookie")!, headers, session, user: saved }
}
