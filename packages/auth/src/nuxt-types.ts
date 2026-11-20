/** Who may open a page: signed-in users (`user`) or signed-out visitors (`guest`). */
export type AuthPageMode = "guest" | "user"

/**
 * The `auth` key of `definePageMeta()` in Nuxt. `'user'` or `true` sends visitors without a session to the login
 * page. `'guest'` sends signed-in users away, for example from the login page. `false` turns the guard off.
 */
export type AuthPageMeta = boolean | AuthPageMode | {
  only?: AuthPageMode
  /** Where to send the visitor instead of the configured redirect. */
  redirectTo?: string
}

/** What the Nuxt page guard reads from the public runtime config: the Auth path and `access` of the Auth Definition. */
export interface AuthPageGuardConfig {
  basePath: string
  /** The sign-in page of `access.signIn`, or `null` when the Auth route starts a provider sign-in. */
  signInPage: string | null
  /** `access.afterSignIn`, where signed-in users go from `auth: 'guest'` pages. */
  afterSignIn: string
}
