export default defineEventHandler(async (event) => {
  const session = await useAuth(event).api.getSession({ headers: event.req.headers, returnHeaders: true }).then(({ headers: sessionHeaders, response: sessionResponse }) => {
    for (const cookie of sessionHeaders.getSetCookie()) event.res.headers.append("set-cookie", cookie)
    return sessionResponse
  })
  const auth = useAuth(event)
  const accounts = await auth.api.listUserAccounts({ headers: event.req.headers })
  return { user: session?.user ?? null, accounts }
})
