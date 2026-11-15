import { ref } from "vue"
import { expectTypeOf, it } from "vitest"

import { clearDevice, inspectDevice, setDeviceAccount } from "../src/index.ts"
import { useStoredData } from "../src/vue.ts"

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
