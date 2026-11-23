import { db as database } from "vite-hub/database"

export const db = database.$withAuth()
