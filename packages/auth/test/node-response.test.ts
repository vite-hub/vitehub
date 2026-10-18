import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import { expect, it, vi } from "vitest"
import { sendWebResponse } from "../src/node-response.ts"

it.each([true, false])("forwards response bodies and separate cookies with getSetCookie=%s", async (hasHelper) => {
  const cookies = ["first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/", "second=2; HttpOnly"]
  const response = new Response("Policy rejected", { status: 409, statusText: "Conflict" })
  for (const cookie of cookies) response.headers.append("set-cookie", cookie)
  if (!hasHelper) Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  const target = new ServerResponse(new IncomingMessage(new Socket()))
  const write = vi.spyOn(target, "write").mockReturnValue(true)
  const end = vi.spyOn(target, "end").mockReturnValue(target)

  await sendWebResponse(response, target)

  expect(target.statusCode).toBe(409)
  expect(target.statusMessage).toBe("Conflict")
  expect(target.getHeader("set-cookie")).toEqual(cookies)
  expect(target.getHeader("content-type")).toBe("text/plain;charset=UTF-8")
  expect(Buffer.concat(write.mock.calls.map(([chunk]) => Buffer.from(chunk))).toString()).toBe("Policy rejected")
  expect(end).toHaveBeenCalledOnce()
})

it("splits fallback cookies with flag-only attributes", async () => {
  const response = new Response(null, { status: 204 })
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  response.headers.set("set-cookie", "first=1; HttpOnly, second=2; Secure")
  const target = new ServerResponse(new IncomingMessage(new Socket()))

  await sendWebResponse(response, target)

  expect(target.getHeader("set-cookie")).toEqual(["first=1; HttpOnly", "second=2; Secure"])
})

it("splits fallback cookies without optional whitespace", async () => {
  const response = new Response(null, { status: 204 })
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  response.headers.set("set-cookie", "first=1; HttpOnly,second=2; Secure")
  const target = new ServerResponse(new IncomingMessage(new Socket()))

  await sendWebResponse(response, target)

  expect(target.getHeader("set-cookie")).toEqual(["first=1; HttpOnly", "second=2; Secure"])
})

it("splits fallback cookies after an Expires date without a semicolon", async () => {
  const response = new Response(null, { status: 204 })
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  response.headers.set("set-cookie", "first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT, second=2")
  const target = new ServerResponse(new IncomingMessage(new Socket()))

  await sendWebResponse(response, target)

  expect(target.getHeader("set-cookie")).toEqual([
    "first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
    "second=2",
  ])
})

it("preserves commas in quoted cookie extension values", async () => {
  const response = new Response(null, { status: 204 })
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  response.headers.set("set-cookie", 'first=1; Foo="x, second=2"')
  const target = new ServerResponse(new IncomingMessage(new Socket()))

  await sendWebResponse(response, target)

  expect(target.getHeader("set-cookie")).toBe('first=1; Foo="x, second=2"')
})

it("preserves commas in unquoted extension values", async () => {
  const response = new Response(null, { status: 204 })
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  response.headers.set("set-cookie", "first=1; Foo=x, second=2")
  const target = new ServerResponse(new IncomingMessage(new Socket()))

  await sendWebResponse(response, target)

  expect(target.getHeader("set-cookie")).toBe("first=1; Foo=x, second=2")
})

it("splits after apostrophes in unquoted cookie values", async () => {
  const response = new Response(null, { status: 204 })
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  response.headers.set("set-cookie", "first=O'Reilly, second=2")
  const target = new ServerResponse(new IncomingMessage(new Socket()))

  await sendWebResponse(response, target)

  expect(target.getHeader("set-cookie")).toEqual(["first=O'Reilly", "second=2"])
})

it("preserves compact commas in known attribute values", async () => {
  const response = new Response(null, { status: 204 })
  Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
  response.headers.set("set-cookie", "first=1; Path=/a,x=1, second=2")
  const target = new ServerResponse(new IncomingMessage(new Socket()))

  await sendWebResponse(response, target)

  expect(target.getHeader("set-cookie")).toBe("first=1; Path=/a,x=1, second=2")
})
