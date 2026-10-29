import { Buffer as NodeBuffer } from "node:buffer"
import { afterEach, expect, it, vi } from "vitest"

import { deserializeResponse } from "../src/response.ts"

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])("restores binary response bodies with Buffer disabled: %s", async (disableBuffer) => {
  for (const length of [0, 1, 2, 3, 65_537]) {
    const bytes = NodeBuffer.alloc(length)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256
    const padded = bytes.toString("base64")
    for (const data of [padded, padded.replace(/=+$/, ""), ` \t${padded}\r\n`]) {
      if (disableBuffer) vi.stubGlobal("Buffer", undefined)
      let response: Response
      try {
        response = deserializeResponse({
          body: { data, encoding: "base64", mediaType: "application/octet-stream" },
          headers: [],
          status: 200,
          statusText: "OK",
        })
      }
      finally {
        // Node's Response body reader needs Buffer even when our decoder does not.
        vi.unstubAllGlobals()
      }
      expect(NodeBuffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
    }
  }
})

it.each([false, true])("rejects malformed Base64 before decoding with Buffer disabled: %s", (disableBuffer) => {
  if (disableBuffer) vi.stubGlobal("Buffer", undefined)
  for (const data of ["AA!=", "__8=", "A", "YQ=", "A==="]) {
    expect(() => deserializeResponse({
      body: { data, encoding: "base64", mediaType: "application/octet-stream" },
      headers: [],
      status: 200,
      statusText: "OK",
    })).toThrow("Invalid serialized Response")
  }
})
