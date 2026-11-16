/**
 * Wraps the `getSession` mock of a Better Auth double so that it answers like Better Auth with `returnHeaders: true`:
 * the mocked session, or `null`, as `response`, with response headers that set no cookie.
 */
export function returnHeaders<TInput>(getSession: (input: TInput) => unknown): (input: TInput) => Promise<{ headers: Headers, response: unknown }> {
  return async input => ({ headers: new Headers(), response: await getSession(input) })
}
