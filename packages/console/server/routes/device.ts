import { renderDevicePage } from "../../src/device-page.ts"

// The page of `vitehub login`, the verification URI of the device flow (consoleCliDeviceFlow() in server/auth.ts).
export default {
  fetch(request: Request): Response {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
    const page = renderDevicePage()
    return request.method === "HEAD" ? new Response(null, { headers: page.headers }) : page
  },
}
