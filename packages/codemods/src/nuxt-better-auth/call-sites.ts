import { end, isReference, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { FollowUp } from "../types.ts"

/** Server helpers of the module with no ViteHub helper of the same shape. */
const serverFollowUps: Record<string, string> = {
  ensureServerAuth: "ViteHub Auth has no ensureServerAuth(). Use useAuth(event) in a request, or getAuth() outside one.",
  setRequestSession: "ViteHub Auth has no setRequestSession(). Sign MCP clients in with mcpOAuth(), or check service tokens with requireServiceToken() from vite-hub/env.",
  refreshSessionCookieCache: "ViteHub Auth has no refreshSessionCookieCache(). Call useAuth(event).api.getSession({ headers: event.req.headers, query: { disableCookieCache: true } }) after the update.",
  createSession: "ViteHub Auth has no createSession(). Use Better Auth's internal adapter through useAuth(event).$context.",
  setSessionCookie: "ViteHub Auth has no setSessionCookie(). Use setSessionCookie() from better-auth/cookies in a Better Auth plugin endpoint.",
}

/** Client helpers of the module with no ViteHub helper of the same shape. */
const clientFollowUps: Array<[RegExp, string]> = [
  [/\buse(?:SignIn|SignUp)\s*\(/, "ViteHub has no useSignIn() or useSignUp(). Call signIn.email(), signIn.social(), or signUp.email() from useUserSession(). They return { data, error }."],
  [/\buseSignOut\s*\(/, "ViteHub has no useSignOut(). Call signOut({ redirectTo }) from useUserSession()."],
  [/\buse(?:Action|AuthClientAction)\s*\(/, "ViteHub has no useAction() or useAuthClientAction(). Call the client method from useUserSession().client and keep the pending state in a ref."],
  [/\buseAuth(?:RequestFetch|AsyncData)\s*\(/, "ViteHub has no useAuthRequestFetch() or useAuthAsyncData(). During server rendering, client calls already send the visitor's cookie. Use useFetch() or useAsyncData() with the client."],
  [/\brunWithSessionRefresh\s*\(/, "ViteHub has no runWithSessionRefresh(). Call refresh() from useUserSession() after the action."],
  [/\buseUserSessionState\s*\(/, "ViteHub has no useUserSessionState(). Use useUserSession()."],
  [/\bfetchSession\b/, "ViteHub's useUserSession() has refresh() in place of fetchSession(). It takes no options and reads the session again."],
  [/\bwaitForSession\b/, "ViteHub's useUserSession() has no waitForSession(). Use await refresh(), or watch ready."],
  [/\bupdateUser\b(?!\s*:)/, "ViteHub's useUserSession() has no updateUser(). Call client.updateUser() from useUserSession(), then refresh()."],
  [/<BetterAuthState\b/, "ViteHub has no <BetterAuthState>. Read ready and loggedIn from useUserSession()."],
]

const typeAlias = "#nuxt-better-auth"

export interface CallSiteResult {
  edits: Array<{ path: string, before: string, after: string }>
  followUps: FollowUp[]
}

/**
 * Renames the module's server helpers to ViteHub Auth: `serverAuth(event)` to `useAuth(event)`,
 * `requireUserSession(event)` to `requireAuth(event)`, and `getUserSession(event)` and `getRequestSession(event)` to
 * Better Auth's `getSession()`. Nuxt auto-imports the ViteHub helpers in server code.
 */
export function rewriteServerFile(file: string, code: string): { after?: string, followUps: FollowUp[] } {
  const followUps: FollowUp[] = []
  let program
  try {
    program = parseProgram(code, { typescript: !/\.[cm]?js$/.test(file) })
  }
  catch {
    return { followUps }
  }
  const resolve = bindingResolver(program)
  const output = new MagicString(code)
  walk(program, (node) => {
    if (node.type === "ImportDeclaration" && node.source.value === typeAlias) {
      followUps.push({ file, line: line(node), message: `${typeAlias} is gone. Import the Better Auth types, or read the user type from useAuth(event).$Infer.Session.` })
      return
    }
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !isReference(node.callee, node)) return
    const name = node.callee.name
    const known = name === "serverAuth" || name === "requireUserSession" || name === "getUserSession" || name === "getRequestSession" || name in serverFollowUps
    // A local or imported binding of the same name is not the module's auto-import.
    if (!known || resolve(node.callee)) return
    const [event, options] = node.arguments
    const eventText = event && event.type !== "SpreadElement" && event.type !== "ArgumentPlaceholder" ? code.slice(start(event), end(event)) : undefined
    const at = { file, line: line(node) }
    if (name in serverFollowUps) followUps.push({ ...at, message: serverFollowUps[name]! })
    else if (!eventText) followUps.push({ ...at, message: `${name}() without the request event has no ViteHub equivalent. Pass the event to useAuth(event), or use getAuth().` })
    else if (name === "serverAuth" && !options) output.overwrite(start(node.callee), end(node.callee), "useAuth")
    else if (name === "requireUserSession" && !options) output.overwrite(start(node.callee), end(node.callee), "requireAuth")
    else if (name === "requireUserSession") followUps.push({ ...at, message: "requireUserSession() with options matched user fields. Use requireAuthorization(event, ({ user }) => <your check>) from ViteHub Auth." })
    else if (event?.type === "Identifier" && !options) {
      output.overwrite(start(node), end(node), `useAuth(${eventText}).api.getSession({ headers: ${eventText}.req.headers })`)
    }
    else followUps.push({ ...at, message: `Replace ${name}() with useAuth(event).api.getSession({ headers: event.req.headers }).` })
  })
  return { after: output.hasChanged() ? output.toString() : undefined, followUps }
}

/** Follow-ups for the module's client composables and components in app code. */
export function clientFollowUpsFor(file: string, code: string): FollowUp[] {
  const followUps: FollowUp[] = []
  code.split("\n").forEach((text, index) => {
    if (text.includes(typeAlias)) followUps.push({ file, line: index + 1, message: `${typeAlias} is gone. Import the Better Auth types, or infer the user from useUserSession().` })
    const found = clientFollowUps.find(([pattern]) => pattern.test(text))
    if (found) followUps.push({ file, line: index + 1, message: found[1] })
  })
  return followUps
}
