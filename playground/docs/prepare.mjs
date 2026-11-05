import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"

// Connections encrypts the ChatGPT grant with this key. Nuxt loads `.env` in development; keep the file across restarts.
try {
  await writeFile(new URL(".env", import.meta.url), `VITEHUB_CONNECTIONS_KEY=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" })
}
catch (error) {
  if (error.code !== "EEXIST") throw error
}
