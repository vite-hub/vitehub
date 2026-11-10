import vm from "node:vm"

import { describe, expect, it } from "vitest"

import { agentResultKind } from "../src/agent-output.ts"
import { isRuntimeFunction, isRuntimeObject } from "../src/internal/runtime-value.ts"

class Instance {}
const realm = vm.createContext({})
const revokedObject = Proxy.revocable({}, {})
revokedObject.revoke()
const revokedFunction = Proxy.revocable(() => undefined, {})
revokedFunction.revoke()

// Pins the results of the former `Function.prototype.toString` probe.
const callableCases: [label: string, value: unknown, callable: boolean][] = [
  ["function", function named() {}, true],
  ["arrow function", () => undefined, true],
  ["async function", async () => undefined, true],
  ["class", Instance, true],
  ["bound function", (() => undefined).bind(null), true],
  ["native function", Math.max, true],
  ["Function.prototype", Function.prototype, true],
  ["function proxy", new Proxy(() => undefined, {}), true],
  ["revoked function proxy", revokedFunction.proxy, true],
  ["cross-realm function", vm.runInContext("(function () {})", realm), true],
  ["cross-realm class", vm.runInContext("(class {})", realm), true],
  ["plain object", { value: 1 }, false],
  ["null-prototype object", Object.create(null), false],
  ["array", [1], false],
  ["class instance", new Instance(), false],
  ["Date", new Date(0), false],
  ["boxed string", Object("value"), false],
  ["process", process, false],
  ["object proxy", new Proxy({}, {}), false],
  ["revoked object proxy", revokedObject.proxy, false],
  ["cross-realm object", vm.runInContext("({ value: 1 })", realm), false],
  ["cross-realm array", vm.runInContext("[1]", realm), false],
]
const primitiveCases: [label: string, value: unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["string", "value"],
  ["number", 1],
  ["symbol", Symbol("value")],
  ["bigint", 1n],
]

describe("Agent runtime representation guards", () => {
  it("classifies hostile proxies without reading their properties", () => {
    const hostile = new Proxy({}, { get() { throw new Error("blocked property") } })
    expect(agentResultKind(hostile)).toBe("object")
  })

  it.each(callableCases)("classifies %s", (_label, value, callable) => {
    expect(isRuntimeFunction(value)).toBe(callable)
    expect(isRuntimeObject(value)).toBe(!callable)
  })

  it.each(primitiveCases)("does not treat %s as a function or an object", (_label, value) => {
    expect(isRuntimeFunction(value)).toBe(false)
    expect(isRuntimeObject(value)).toBe(false)
  })
})
