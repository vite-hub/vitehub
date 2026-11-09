import { memoryAdapter } from "better-auth/adapters/memory"
import { H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthDefinition } from "../src/types.ts"

const definition = vi.hoisted(() => ({ current: undefined as AuthDefinition | undefined }))
vi.mock("#vitehub/auth/definition", () => ({
  get default() { return definition.current },
}))
vi.mock("#vitehub/auth/abilities", () => import("./fixtures/abilities.ts"))

import { checkAbility } from "../src/ability-check.ts"
import { defineAbilities, deny, guest } from "../src/abilities.ts"
import { defineAuth } from "../src/definition.ts"
import authRoute, { AbilityError, can, requireAbility, resetAuth } from "../src/server.ts"
import abilities from "./fixtures/abilities.ts"

const origin = "https://app.example.com"
const credentials = { email: "author@example.com", name: "Author", password: "correct-horse-battery" }

let cookie = ""
let userId = ""
let db: Record<string, unknown[]> = {}

function authOptions() {
  return {
    emailAndPassword: { enabled: true },
    runtime: { database: memoryAdapter(db), secret: "abcdefghijklmnopqrstuvwxyz0123456789" },
  }
}

beforeEach(async () => {
  db = { account: [], session: [], user: [], verification: [] }
  definition.current = defineAuth(authOptions())
  const signUp = await authRoute.fetch(new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify(credentials),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(signUp.status).toBe(200)
  cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
  userId = (await signUp.json() as { user: { id: string } }).user.id
})

afterEach(() => {
  definition.current = undefined
  resetAuth()
})

function signedIn(path = "/"): Request {
  return new Request(`${origin}${path}`, { headers: { cookie } })
}

function signedOut(path = "/"): Request {
  return new Request(`${origin}${path}`)
}

describe("ability rules", () => {
  const user = { id: "u1", name: "Ada" }

  it("allows only on true", () => {
    expect(checkAbility(abilities, user, "posts.edit", [{ authorId: "u1", published: false }])).toBeNull()
    expect(checkAbility(defineAbilities({ open: () => false }), user, "open", [])).toEqual({ status: 403 })
    // A missing return refuses too.
    expect(checkAbility(defineAbilities({ open: (() => undefined) as never }), user, "open", [])).toEqual({ status: 403 })
  })

  it("turns a code into 403 and deny() into its own status and details", () => {
    expect(checkAbility(abilities, user, "posts.edit", [{ authorId: "u2", published: false }])).toEqual({ status: 403, code: "not-author" })
    expect(checkAbility(abilities, user, "posts.delete", [{ authorId: "u2", published: false }])).toEqual({ status: 404, code: "not-found", details: undefined })
    expect(checkAbility(abilities, user, "billing.upgrade", [])).toEqual({ status: 402, code: "plan-limit", details: { limit: 3 } })
    expect(Object.isFrozen(deny("x"))).toBe(true)
  })

  it("refuses a signed-out user with 401 before the rule runs, unless the rule is open to guests", () => {
    const rule = vi.fn(() => true)
    expect(checkAbility(defineAbilities({ rule }), null, "rule", [])).toEqual({ status: 401, code: "signed-out" })
    expect(rule).not.toHaveBeenCalled()
    expect(checkAbility(abilities, null, "posts.read", [{ authorId: "u2", published: true }])).toBeNull()
    expect(checkAbility(abilities, null, "posts.read", [{ authorId: "u2", published: false }])).toEqual({ status: 403 })
  })

  it("marks a guest rule without changing what it answers", () => {
    const rule = guest((_user, post: { published: boolean }) => post.published)
    expect(rule.guest).toBe(true)
    expect(rule(null, { published: true })).toBe(true)
  })

  it("fails on an unknown name and on a rule that returns a Promise", () => {
    expect(() => checkAbility(abilities, user, "posts.missing", [])).toThrow(/AUTH_R0020|no ability named "posts\.missing"/)
    // An own property only: names from Object.prototype are not rules.
    expect(() => checkAbility(abilities, user, "toString", [])).toThrow(/no ability named/)
    const slow = defineAbilities({ slow: (() => Promise.resolve(true)) as never })
    expect(() => checkAbility(slow, user, "slow", [])).toThrow(/returned a Promise/)
  })
})

describe("requireAbility()", () => {
  it("returns the checked request, session, and user when the rule allows", async () => {
    const request = signedIn()
    const authorization = await requireAbility(request, "posts.edit", { authorId: userId, published: false })
    expect(authorization.user.id).toBe(userId)
    expect(authorization.request).toBe(request)
    expect(Object.isFrozen(authorization)).toBe(true)
  })

  it("throws 401 signed-out without a session, and 403 with the rule's code", async () => {
    await expect(requireAbility(signedOut(), "posts.edit", { authorId: userId, published: false })).rejects.toMatchObject({
      name: "HTTPError",
      status: 401,
      statusText: "Unauthorized",
      data: { code: "signed-out" },
    })
    const error = await requireAbility(signedIn(), "posts.edit", { authorId: "someone-else", published: false }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AbilityError)
    expect(error).toMatchObject({ status: 403, statusCode: 403, data: { code: "not-author" } })
  })

  it("lets a guest rule return a signed-out caller", async () => {
    const authorization = await requireAbility(signedOut(), "posts.read", { authorId: userId, published: true })
    expect(authorization.user).toBeNull()
  })

  it("reads the session once per request", async () => {
    const resolved = vi.fn(authOptions)
    definition.current = defineAuth(resolved)
    const request = signedIn()
    await can(request, "posts.edit", { authorId: userId, published: false })
    await can(request, "posts.create")
    await requireAbility(request, "admin.open").catch(() => undefined)
    expect(resolved).toHaveBeenCalledOnce()
    await can(signedIn(), "posts.create")
    expect(resolved).toHaveBeenCalledTimes(2)
  })
})

describe("can()", () => {
  it("answers each rule for the caller", async () => {
    expect(await can(signedIn(), "posts.edit", { authorId: userId, published: false })).toBe(true)
    expect(await can(signedIn(), "posts.edit", { authorId: "someone-else", published: false })).toBe(false)
    expect(await can(signedIn(), "posts.move", "a", "b")).toBe(true)
    expect(await can(signedIn(), "posts.create")).toBe(false)
    expect(await can(signedOut(), "posts.create")).toBe(false)
  })

  it("passes default, rest, and optional arguments as the caller gives them", async () => {
    const other = { authorId: "someone-else", published: false }
    expect(await can(signedIn(), "posts.review", other)).toBe(false)
    expect(await can(signedIn(), "posts.review", other, "read")).toBe(true)
    expect(await can(signedIn(), "posts.tag")).toBe(false)
    expect(await can(signedIn(), "posts.tag", "a", "b")).toBe(true)
    expect(await can(signedIn(), "posts.tag", "a", "b", "c")).toBe(false)
    expect(await can(signedIn(), "posts.draft")).toBe(true)
    expect(await can(signedIn(), "posts.draft", other)).toBe(false)
  })
})

describe("H3 2 route", () => {
  const app = new H3()
    .get("/posts/:author", async (event) => {
      const authorId = event.context.params!.author!
      const { user } = await requireAbility(event, "posts.edit", { authorId, published: false })
      return { user: user.id }
    })
    .get("/billing", async (event) => {
      await requireAbility(event, "billing.upgrade")
      return "ok"
    })

  it("answers the rule's status and puts the code and details in data", async () => {
    const allowed = await app.fetch(signedIn(`/posts/${userId}`))
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ user: userId })

    const notAuthor = await app.fetch(signedIn("/posts/someone-else"))
    expect(notAuthor.status).toBe(403)
    expect(await notAuthor.json()).toMatchObject({ status: 403, statusText: "Forbidden", data: { code: "not-author" } })

    const anonymous = await app.fetch(signedOut(`/posts/${userId}`))
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ data: { code: "signed-out" } })

    const billing = await app.fetch(signedIn("/billing"))
    expect(billing.status).toBe(402)
    expect(await billing.json()).toMatchObject({ data: { code: "plan-limit", details: { limit: 3 } } })
  })
})
