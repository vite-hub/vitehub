export default {
  fetch() {
    const env = useServerEnv()
    if (!env.SITE_URL) return new Response("Missing SITE_URL", { status: 500 })
  },
}
