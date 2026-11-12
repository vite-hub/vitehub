import type { ShippedMigrations } from "./migrate-on-start.ts"

// The Vite integration replaces this module with the migrations of the app's Databases.
const migrations: ShippedMigrations = { allowDataLoss: false, databases: {} }

export default migrations
