export default defineEventHandler(async () => {
  await kv.set("settings", { enabled: true })
})
