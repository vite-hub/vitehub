import { ref } from "vue"
import { expectTypeOf, it } from "vitest"

import { clearDevice, inspectDevice, setDeviceAccount } from "../src/index.ts"
import { useStoredData, useStoredFetch } from "../src/vue.ts"

import type { Result } from "@vite-hub/runtime"
import type { StoredDataStatus } from "../src/vue.ts"

interface Project {
  id: string
  name: string
}

declare function loadProjects(signal: AbortSignal): Promise<Project[]>

it("types data as the answer of the loader or the default", () => {
  const projects = useStoredData("projects", ({ signal }) => loadProjects(signal))
  expectTypeOf(projects.data.value).toEqualTypeOf<Project[] | undefined>()
  expectTypeOf(projects.status.value).toEqualTypeOf<StoredDataStatus>()
  expectTypeOf(projects.error.value).toEqualTypeOf<Error | undefined>()
  expectTypeOf(projects.storedAt.value).toEqualTypeOf<Date | undefined>()
  expectTypeOf(projects.refresh).returns.toEqualTypeOf<Promise<void>>()

  const withDefault = useStoredData("projects", ({ signal }) => loadProjects(signal), { default: (): Project[] => [] })
  expectTypeOf(withDefault.data.value).toEqualTypeOf<Project[]>()
})

it("takes a ref or a getter as the key", () => {
  const id = ref("p1")
  useStoredData(() => `project:${id.value}`, async () => ({ id: id.value }))
  useStoredData(id, async () => ({ id: id.value }))
  // @ts-expect-error A key is a string.
  useStoredData(42, async () => 1)
})

it("returns a Result from the functions that change the disk", () => {
  expectTypeOf(setDeviceAccount("ada")).toEqualTypeOf<Promise<Result<void, "DEVICE_STORAGE_FAILED">>>()
  expectTypeOf(clearDevice()).toEqualTypeOf<Promise<Result<void, "DEVICE_STORAGE_FAILED">>>()
  expectTypeOf(inspectDevice().entries).items.toEqualTypeOf<{ key: string, storedAt: Date, bytes: number }>()
})

it("types the answer of useStoredFetch() from its type argument, with a default of the same type", () => {
  const plain = useStoredFetch("/api/projects")
  expectTypeOf(plain.data.value).toEqualTypeOf<unknown>()

  const typed = useStoredFetch<Project[]>("/api/projects")
  expectTypeOf(typed.data.value).toEqualTypeOf<Project[] | undefined>()

  const withDefault = useStoredFetch<Project[]>("/api/projects", { default: () => [] })
  expectTypeOf(withDefault.data.value).toEqualTypeOf<Project[]>()

  const withNull = useStoredFetch<Project[], null>("/api/projects", { default: () => null })
  expectTypeOf(withNull.data.value).toEqualTypeOf<Project[] | null>()

  const session = useStoredFetch<{ user: { id: string } | null }>("/api/session", { account: value => value.user?.id ?? null })
  expectTypeOf(session.data.value).toEqualTypeOf<{ user: { id: string } | null } | undefined>()
})

it("takes a ref or a getter as the URL and the query", () => {
  const team = ref("t1")
  useStoredFetch(() => `/api/teams/${team.value}`, { query: () => ({ page: 1, open: true, owner: null }) })
  useStoredFetch(team, { query: ref({ team: "t1" }) })
  // @ts-expect-error A query value is a string, a number, a boolean, null, or undefined.
  useStoredFetch("/api/projects", { query: { since: new Date() } })
  // @ts-expect-error The default has the type of the data.
  useStoredFetch<Project[]>("/api/projects", { default: () => "none" })
})
