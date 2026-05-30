import { defineEventHandler } from "h3"

import { blob } from "@vite-hub/blob"

export default defineEventHandler(async () => await blob.list({ limit: 10 }))
