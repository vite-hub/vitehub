export default defineEventHandler(() => {
  return kv.get("settings")
})
