import { defineEventHandler } from "h3"

import { blob } from "@vitehub/blob"

export default defineEventHandler(async () => await blob.list({ limit: 10 }))
