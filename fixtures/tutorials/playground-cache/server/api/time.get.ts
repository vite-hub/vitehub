import { defineCachedHandler } from "nitro/cache"

let renders = 0

// Reload the preview: the response stays the same for 10 seconds.
export default defineCachedHandler(() => ({ renders: ++renders, at: new Date().toISOString() }), {
  maxAge: 10,
  name: "time",
})
