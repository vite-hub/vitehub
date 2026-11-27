import { defineEventHandler } from "h3"

export default defineEventHandler(() => ({ runQueue: "a plain key in a file that does not import Queue" }))
