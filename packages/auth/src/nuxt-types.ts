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

/** Where the Nuxt page guard sends visitors. */
export interface AuthRedirects {
  /** The login page for `auth: 'user'` pages. The guard adds `?redirect=<the page>`. Default `/login`. */
  login?: string
  /** Where signed-in users go from `auth: 'guest'` pages. Default `/`. */
  guest?: string
}

/**
 * Nuxt pages that the page guard protects, by route pattern, such as `'/dashboard/**'`. A key has static segments,
 * `:name`, and a last `**`. `'user'` and `'guest'` work as in `definePageMeta({ auth })`. `false` removes the guard
 * of a wider pattern from the matching pages.
 */
export type AuthRoutes = Record<`/${string}`, AuthPageMode | false>
