import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { toBrowserError } from "../src/errors.ts"
describe("toBrowserError",()=>{it("preserves messages from errors created in another realm",()=>{const error=runInNewContext("new Error('cross-realm failure')"); expect(error).not.toBeInstanceOf(Error); expect(toBrowserError(error).message).toBe("cross-realm failure")})})
