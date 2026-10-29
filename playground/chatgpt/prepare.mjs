import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"

try {
  await writeFile(new URL(".env.local", import.meta.url), `VITEHUB_CONNECTIONS_KEY=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" })
}
catch (error) {
  if (error.code !== "EEXIST") throw error
}
