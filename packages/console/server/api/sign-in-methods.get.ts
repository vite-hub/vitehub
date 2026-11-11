// What the sign-in page offers. Passkeys always work. GitHub needs an OAuth app: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.
export default {
  fetch(): Response {
    return Response.json({ github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) }, { headers: { "cache-control": "no-store" } })
  },
}
