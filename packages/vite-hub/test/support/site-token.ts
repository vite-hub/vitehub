import { createSiteIntent, signSiteToken, siteStateHash } from "@vite-hub/internal/site-token"

import type { ConsoleSigningKey } from "@vite-hub/internal/console-signature"
import type { SiteTokenClaims, SiteTokenKind, SiteTokenTarget } from "@vite-hub/internal/site-token"
import type { ConsoleRoute } from "../../src/console/runtime/server/request.ts"

export function cookieJar(cookie: string, response: Response): string {
  const values = new Map(cookie.split("; ").filter(Boolean).map(pair => [pair.slice(0, pair.indexOf("=")), pair] as const))
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]!
    const name = pair.slice(0, pair.indexOf("="))
    if (/max-age=0/i.test(header) || pair.endsWith("=")) values.delete(name)
    else values.set(name, pair)
  }
  return [...values.values()].join("; ")
}

export async function siteActionBrowser(route: ConsoleRoute, app: string, cookie = ""): Promise<{
  cookie: string
  intent: string
  state: string
  visit: URL
  token(input: { key: ConsoleSigningKey, kind: SiteTokenKind, target?: SiteTokenTarget, claims?: Partial<Omit<SiteTokenClaims, "iat" | "exp">>, now?: number }): Promise<string>
  open(token: string, cookie?: string): Promise<Response>
}> {
  const intent = createSiteIntent()
  const started = await route.fetch(new Request(`${app}/_vitehub/site?${new URLSearchParams({ return: "/", intent })}`, { headers: cookie ? { cookie } : {} }))
  if (started.status !== 303) throw new Error(`The visit did not start: ${started.status} ${await started.text()}`)
  const jar = cookieJar(cookie, started)
  const state = started.headers.getSetCookie()[0]?.split(";")[0]?.split("=")[1] ?? ""
  return {
    cookie: jar,
    intent,
    state,
    visit: new URL(started.headers.get("location") ?? ""),
    token: async input => await signSiteToken({
      key: input.key,
      claims: { aud: app, sub: "console-operator", name: "Operator", email: "operator@example.com", roles: [], kind: input.kind, path: "/", state: await siteStateHash(state), ...(input.target ? { target: input.target } : {}), ...input.claims },
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    open: async (token, override) => await route.fetch(new Request(`${app}/_vitehub/site?${new URLSearchParams({ token, intent })}`, { headers: { cookie: override ?? jar } })),
  }
}
