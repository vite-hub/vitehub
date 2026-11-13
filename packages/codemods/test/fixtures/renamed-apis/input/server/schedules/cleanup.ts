import { defineSchedule } from "vite-hub/schedule"
import { blob } from "vite-hub/blob"
import { kv } from "vite-hub/kv"

export default defineSchedule({
  cron: "0 1 * * *",
  async run() {
    const [keysError, keys] = await kv.keys("drafts:")
    if (keysError) throw keysError
    for (const key of keys) await kv.del(key)
    const [listError, page] = await blob.list({ prefix: "drafts/" })
    if (listError) throw listError
    await blob.del(page.blobs.map(object => object.pathname))
  },
})
