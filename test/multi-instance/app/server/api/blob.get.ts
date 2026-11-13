import { defineHandler, getQuery } from "h3"
import { blob } from "vite-hub/blob"

export default defineHandler(async (event) => {
  const [error, object] = await blob.get(String(getQuery(event).path))
  if (error) throw error
  return { value: object ? await object.text() : null }
})
