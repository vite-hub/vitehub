import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { expect, it } from "vitest"

import { writeWebResponse } from "./local/vercel-bridge.mjs"

it("forwards separate Set-Cookie values and ordinary response headers", async () => {
  const cookies = ["session=first; HttpOnly", "csrf=second; SameSite=Lax"]
  const response = new Response(null, {
    status: 201,
    headers: [["set-cookie", cookies[0]!], ["set-cookie", cookies[1]!], ["x-test", "present"]],
  })
  const nodeResponse = new ServerResponse(new IncomingMessage(new Socket()))
  await writeWebResponse(nodeResponse, response)
  expect(nodeResponse.getHeader("set-cookie")).toEqual(cookies)
  expect(nodeResponse.getHeader("x-test")).toBe("present")
  expect(nodeResponse.statusCode).toBe(201)
})

it("does not add a Set-Cookie header when the response has none", async () => {
  const nodeResponse = new ServerResponse(new IncomingMessage(new Socket()))
  await writeWebResponse(nodeResponse, new Response(null))
  expect(nodeResponse.hasHeader("set-cookie")).toBe(false)
})
