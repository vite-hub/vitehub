import { afterEach, describe, expect, it, vi } from "vitest"

import { isProcessRunning, signalProcess } from "../src/internal/drain-process.ts"

describe("isProcessRunning", () => {
  afterEach(() => vi.restoreAllMocks())

  it("treats EPERM from kill(pid, 0) as a live process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      throw error
    })

    expect(isProcessRunning(4242)).toBe(true)
  })

  it("treats ESRCH from kill(pid, 0) as an exited process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = Object.assign(new Error("no such process"), { code: "ESRCH" })
      throw error
    })

    expect(isProcessRunning(4242)).toBe(false)
  })

  it("continues status polling when signal delivery is denied", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      throw error
    })

    expect(signalProcess(4242)).toBe("permission-denied")
  })

  it("rethrows signal failures other than EPERM", () => {
    const error = Object.assign(new Error("no such process"), { code: "ESRCH" })
    vi.spyOn(process, "kill").mockImplementation(() => { throw error })

    expect(() => signalProcess(4242)).toThrow(error)
  })
})
