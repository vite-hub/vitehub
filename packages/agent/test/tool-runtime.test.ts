import { describe, expect, it, vi } from "vitest"
import { inspectAgentTools } from "../src/tool-inspection.ts"
import { applyAgentToolPolicies, copyToolWithOverrides, withAgentToolStepReporting, withJsonCompatibleToolOutputs } from "../src/tool-runtime.ts"

describe("tool accessor receivers", () => {
  it.each([true, false])("preserves private state through preparation (own accessor: %s)", async (own) => {
    const unrelated = vi.fn(() => { throw new Error("unrelated getter") })
    const symbol = Symbol("state")
    class Tool {
      #description = "Look up a record"
      name = "lookup"
      policy = () => "allow" as const
      execute = async () => ({ found: true })
      get description() { return this.#description }
      set description(value: string) { this.#description = value }
    }
    const tool = new Tool()
    if (own) {
      Object.defineProperty(tool, "description", {
        ...Object.getOwnPropertyDescriptor(Tool.prototype, "description"),
        configurable: false,
        enumerable: true,
      })
    }
    const state = new WeakMap([[tool, "private state"]])
    Object.defineProperty(tool, symbol, { get() { return state.get(this) }, enumerable: false })
    Object.defineProperty(tool, "unrelated", { get: unrelated })
    const report = vi.fn(async () => undefined)
    const prepared = withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies({ lookup: tool })!), report).lookup
    expect(Object.getPrototypeOf(prepared)).toBe(Tool.prototype)
    expect(prepared.description).toBe("Look up a record")
    expect(Reflect.get(prepared, symbol)).toBe("private state")
    expect(Object.getOwnPropertyDescriptor(prepared, "description")).toMatchObject({
      configurable: !own,
      enumerable: own,
      get: expect.any(Function),
      set: expect.any(Function),
    })
    prepared.description = "Updated description"
    expect(tool.description).toBe("Updated description")
    expect(inspectAgentTools({ lookup: prepared })?.[0]?.description).toBe("Updated description")
    await expect(prepared.execute()).resolves.toEqual({ found: true })
    expect(report).toHaveBeenCalledTimes(2)
    expect(unrelated).not.toHaveBeenCalled()
  })

  it("keeps explicit overrides and shadowing ahead of inherited accessors", () => {
    const getter = vi.fn(() => { throw new Error("shadowed getter") })
    const prototype = Object.defineProperty({}, "description", { get: getter })
    const tool = Object.create(prototype, { description: { value: "own", enumerable: true } })
    expect(copyToolWithOverrides(tool, {}).description).toBe("own")
    expect(copyToolWithOverrides(tool, { description: "override" }).description).toBe("override")
    expect(getter).not.toHaveBeenCalled()
  })

  it("preserves inherited accessors named __proto__ without changing the copy prototype", () => {
    const state = new WeakMap<object, string>()
    const prototype = Object.defineProperty({}, "__proto__", { get(this: object) { return state.get(this) } })
    const tool: object = Object.create(prototype)
    state.set(tool, "original state")
    const copy = copyToolWithOverrides(tool, {})
    expect(Object.getPrototypeOf(copy)).toBe(prototype)
    expect(Reflect.get(copy, "__proto__")).toBe("original state")
  })

  it("keeps platform prototype accessors on the copy's prototype chain", () => {
    const tool = { name: "lookup" }
    const copy = copyToolWithOverrides(tool, {})
    expect(Object.hasOwn(copy, "__proto__")).toBe(false)
    const prototype = { changed: true }
    Reflect.set(copy, "__proto__", prototype)
    expect(Object.getPrototypeOf(copy)).toBe(prototype)
    expect(Object.getPrototypeOf(tool)).toBe(Object.prototype)
  })
})
