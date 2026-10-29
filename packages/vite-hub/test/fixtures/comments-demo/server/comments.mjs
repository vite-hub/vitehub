import { defineComments } from "vite-hub/comments"

// Everyone may do everything: this is a demo.
export default defineComments({ authorize: () => true })
