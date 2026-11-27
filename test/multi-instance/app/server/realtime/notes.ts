import { defineRealtime } from "vite-hub/realtime"

export default defineRealtime({
  access: "public",
  document: {
    kind: "empty",
    load: () => ({ body: "", digest: null }),
    save: () => ({ digest: String(Date.now()) }),
  },
})
