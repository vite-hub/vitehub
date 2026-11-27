import { renderOAuthPage } from "../../src/oauth-page.ts"

export default {
  fetch(request: Request): Response {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 })
    const page = renderOAuthPage()
    return request.method === "HEAD" ? new Response(null, { headers: page.headers }) : page
  },
}
