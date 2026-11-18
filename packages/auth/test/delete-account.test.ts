import { registerViteHubUserData } from "@vite-hub/internal/runtime/user-data"
import { memoryAdapter } from "better-auth/adapters/memory"
import { APIError } from "better-auth/api"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/definition.ts"
import { createAuth } from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

import type { BetterAuthPlugin } from "better-auth"
import type { AuthDeleteAccountOptions } from "../src/index.ts"

const origin = "https://app.example.com"
const account = { email: "ada@example.com", name: "Ada", password: "passwordpassword" }
const owners: string[] = []

function owner(name: string, remove: (userId: string) => Promise<void>) {
  owners.push(name)
  registerViteHubUserData({ owner: name, tables: [`${name}_rows`], delete: remove })
}

afterEach(() => {
  // Each test registers its own owners. An owner that deletes nothing stands in for one that a test removed.
  for (const name of owners.splice(0)) registerViteHubUserData({ owner: name, tables: [], delete: async () => {} })
})

// A plugin table that names the user with a reference, and one that names it in `referenceId`, as `apiKey()` does.
const notes: BetterAuthPlugin = {
  id: "notes",
  schema: {
    note: { fields: { userId: { type: "string", required: true, references: { model: "user", field: "id" } } } },
    apikey: { fields: { referenceId: { type: "string", required: true } } },
  },
}

async function signedUp(deleteAccount?: true | AuthDeleteAccountOptions) {
  const tables: Record<string, Record<string, unknown>[]> = { account: [], apikey: [], note: [], session: [], user: [], verification: [] }
  const auth = createAuth(defineFixedAuth({
    baseURL: origin,
    database: memoryAdapter(tables),
    emailAndPassword: { enabled: true },
    plugins: [notes],
    secret: "vitehub-delete-account-test-secret-5d1c7e9a",
    ...(deleteAccount ? { deleteAccount } : {}),
  }))
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
    const { deleteAccount, signIn, tables, userId } = await signedUp({ beforeDelete: async (user) => {
      order.push(`app:${user.id}`)
    } })
    tables.note!.push({ id: "note-1", userId }, { id: "note-2", userId: "grace" })
    tables.apikey!.push({ id: "key-1", referenceId: userId }, { id: "key-2", referenceId: "grace" })

    await expect(deleteAccount()).resolves.toMatchObject({ success: true })
    expect(order).toEqual([`app:${userId}`, `comments:${userId}`, `forms:${userId}`])
    expect(tables.note!.map(row => row.id)).toEqual(["note-2"])
    expect(tables.apikey!.map(row => row.id)).toEqual(["key-2"])
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
})
