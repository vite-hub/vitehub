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
