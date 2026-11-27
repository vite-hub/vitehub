export default {
  fetch(): Response {
    return Response.json({ github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) }, { headers: { "cache-control": "no-store" } })
  },
}
