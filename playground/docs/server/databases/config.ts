import { defineDatabase } from "vite-hub/database"

// Connections stores the ChatGPT grant here. vite-hub/nuxt needs a Database Definition for Connections.
export default defineDatabase({ schema: {} })
