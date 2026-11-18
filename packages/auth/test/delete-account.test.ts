import { registerViteHubUserData } from "@vite-hub/internal/runtime/user-data"
import { apiKey } from "@better-auth/api-key"
import { memoryAdapter } from "better-auth/adapters/memory"
import { APIError } from "better-auth/api"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/definition.ts"
import { createAuth } from "../src/internal/server.ts"
import { stateless } from "../src/presets.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

import type { BetterAuthPlugin } from "better-auth"
import type { AuthDefinition, AuthDeleteAccountOptions } from "../src/index.ts"

const origin = "https://app.example.com"
const account = { email: "ada@example.com", name: "Ada", password: "passwordpassword" }
const host = vi.hoisted(() => ({ app: {} as object, definition: undefined as AuthDefinition | undefined }))
vi.mock("#vitehub/auth/definition", () => ({ get default() { return host.definition }, getAuthApp: () => host.app }))

function owner(name: string, remove: (userId: string) => Promise<void>) {
  registerViteHubUserData(host.app, { owner: name, tables: [`${name}_rows`], delete: remove })
}

afterEach(() => {
  host.app = {}
  host.definition = undefined
})

const notes: BetterAuthPlugin = {
  id: "notes",
  schema: {
    note: { fields: { userId: { type: "string", required: true, references: { model: "user", field: "id" } } } },
    emailNote: { fields: { email: { type: "string", required: true, references: { model: "user", field: "email" } } } },
  },
}

async function signedUp(deleteAccount?: true | AuthDeleteAccountOptions) {
  const tables: Record<string, Record<string, unknown>[]> = { account: [], apikey: [], emailNote: [], note: [], session: [], user: [], verification: [] }
  const definition = defineFixedAuth({
    baseURL: origin,
    database: memoryAdapter(tables),
    emailAndPassword: { enabled: true },
    plugins: [notes, apiKey([{ configId: "personal", references: "user" }, { configId: "business", references: "organization" }])],
    secret: "vitehub-delete-account-test-secret-5d1c7e9a",
    ...(deleteAccount ? { deleteAccount } : {}),
  })
  host.definition = definition
  const auth = createAuth(definition)
  const signUp = await auth.api.signUpEmail({ body: account, returnHeaders: true })
  const headers = new Headers({ cookie: signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") })
  const deleteAccountRequest = () => auth.api.deleteUser({ body: { password: account.password }, headers })
  const signIn = () => auth.api.signInEmail({ body: { email: account.email, password: account.password } }).then(() => true, () => false)
  return { auth, deleteAccount: deleteAccountRequest, signIn, tables, userId: signUp.response.user.id }
}

describe("deleteAccount", () => {
  it("deletes the rows of the user in each Server Primitive, after the app's beforeDelete", async () => {
    const order: string[] = []
    owner("comments", async (userId) => {
      order.push(`comments:${userId}`)
    })
    owner("forms", async (userId) => {
      order.push(`forms:${userId}`)
    })
    const { deleteAccount, signIn, tables, userId } = await signedUp({ userApiKeyConfigIds: ["personal"], beforeDelete: async (user) => {
      order.push(`app:${user.id}`)
    } })
    tables.note!.push({ id: "note-1", userId }, { id: "note-2", userId: "grace" })
    tables.emailNote!.push({ id: "email-1", email: account.email }, { id: "email-2", email: "grace@example.com" })
    tables.apikey!.push(
      { id: "personal-key", configId: "personal", referenceId: userId },
      { id: "organization-key", configId: "business", referenceId: userId },
      { id: "other-user-key", configId: "personal", referenceId: "grace" },
    )
    host.app = {}
    const otherApp = vi.fn(async () => {})
    owner("comments", otherApp)
    owner("forms", otherApp)

    await expect(deleteAccount()).resolves.toMatchObject({ success: true })
    expect(order).toEqual([`app:${userId}`, `comments:${userId}`, `forms:${userId}`])
    expect(tables.note!.map(row => row.id)).toEqual(["note-2"])
    expect(tables.emailNote!.map(row => row.id)).toEqual(["email-2"])
    expect(tables.apikey!.map(row => row.id)).toEqual(["organization-key", "other-user-key"])
    expect(otherApp).not.toHaveBeenCalled()
    expect(await signIn()).toBe(false)
  })

  it("keeps the account when beforeDelete refuses", async () => {
    const remove = vi.fn(async () => {})
    owner("comments", remove)
    const { deleteAccount, signIn } = await signedUp({ beforeDelete: async () => {
      throw new APIError("BAD_REQUEST", { message: "Leave your household first." })
    } })

    await expect(deleteAccount()).rejects.toMatchObject({ message: "Leave your household first." })
    expect(remove).not.toHaveBeenCalled()
    expect(await signIn()).toBe(true)
  })

  it("keeps the account when a Server Primitive fails, so the user can try again", async () => {
    const failure = new Error("no such table: vitehub_comment_messages")
    owner("comments", vi.fn<(userId: string) => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue())
    const { deleteAccount, signIn } = await signedUp(true)

    await expect(deleteAccount()).rejects.toMatchObject({ code: "AUTH_DELETE_ACCOUNT_FAILED", cause: failure })
    expect(await signIn()).toBe(true)
    await expect(deleteAccount()).resolves.toMatchObject({ success: true })
    expect(await signIn()).toBe(false)
  })

  it("leaves Better Auth deleteUser off without deleteAccount", async () => {
    const { deleteAccount } = await signedUp()
    await expect(deleteAccount()).rejects.toMatchObject({ status: "NOT_FOUND" })
  })

  it("rejects Better Auth user.deleteUser and invalid options", () => {
    expect(() => defineAuth({ user: { deleteUser: { enabled: true } } })).toThrow(expect.objectContaining({ code: "AUTH_DELETE_USER_UNSUPPORTED" }))
    // @ts-expect-error `deleteAccount` always turns deletion on.
    expect(() => defineAuth({ deleteAccount: { enabled: false } })).toThrow(expect.objectContaining({ code: "AUTH_DELETE_ACCOUNT_INVALID" }))
    // @ts-expect-error `false` is the same as leaving the option out.
    expect(() => defineAuth({ deleteAccount: false })).toThrow(expect.objectContaining({ code: "AUTH_DELETE_ACCOUNT_INVALID" }))
    const callback = defineAuth(() => ({ baseURL: origin, database: "memory", secret: "vitehub-delete-account-test-secret-5d1c7e9a", user: { deleteUser: { enabled: true } } }))
    expect(() => createAuth(callback)).toThrow(expect.objectContaining({ code: "AUTH_DELETE_USER_UNSUPPORTED" }))
  })

  it("rejects account deletion when a cookie can authenticate without stored sessions", () => {
    const options = { preset: stateless(), deleteAccount: true } as const
    const error = expect.objectContaining({ code: "AUTH_DELETE_ACCOUNT_SESSION" })
    expect(() => defineAuth(options)).toThrow(error)
    expect(() => createAuth(defineAuth(() => options))).toThrow(error)
    expect(() => defineAuth({ deleteAccount: true, session: { cookieCache: { enabled: true } } })).toThrow(error)
  })
})
