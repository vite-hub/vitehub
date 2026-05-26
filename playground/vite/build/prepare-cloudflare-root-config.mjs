import { readFile, writeFile } from "node:fs/promises"

const configPath = new URL("../dist/vite/wrangler.json", import.meta.url)
const rootConfigPath = new URL("../../../wrangler.json", import.meta.url)
const config = JSON.parse(await readFile(configPath, "utf8"))

config.name = "vitehub-chat-devtools"
config.main = "playground/vite/dist/vite/index.js"

await writeFile(rootConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
