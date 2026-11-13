import { defineRealtime } from "vite-hub/realtime"

// The check uses presence only, so the stored document can stay empty.
export default defineRealtime({
  access: "public",
  document: {
    kind: "empty",
    load: () => ({ body: "", digest: null }),
    save: () => ({ digest: String(Date.now()) }),
  },
})
