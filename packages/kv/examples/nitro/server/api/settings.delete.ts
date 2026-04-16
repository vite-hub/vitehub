export default defineEventHandler(async () => {
  await kv.del("settings")
})
