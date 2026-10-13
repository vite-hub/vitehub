import { beforeEach, expect, it, vi } from "vitest"

import { hasLiveGroupMember } from "./local/process.mjs"

const proc = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("node:fs/promises", () => proc)

beforeEach(() => {
  vi.resetAllMocks()
})

for (const code of ["ENOENT", "ESRCH"]) {
  it.skipIf(process.platform !== "linux")(`continues scanning when a process disappears with ${code}`, async () => {
    proc.readdir.mockResolvedValue(["100", "101"])
    proc.readFile
      .mockRejectedValueOnce(Object.assign(new Error("process disappeared"), { code }))
      .mockResolvedValueOnce("101 (worker) S 1 42 42")

    await expect(hasLiveGroupMember(42)).resolves.toBe(true)
    expect(proc.readFile).toHaveBeenCalledWith("/proc/101/stat", "utf8")
  })
}

it.skipIf(process.platform !== "linux")("preserves other process scan errors", async () => {
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" })
  proc.readdir.mockResolvedValue(["100"])
  proc.readFile.mockRejectedValue(error)

  await expect(hasLiveGroupMember(42)).rejects.toBe(error)
})
