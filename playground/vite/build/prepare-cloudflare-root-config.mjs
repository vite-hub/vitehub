import { writeFile } from "node:fs/promises"

const rootConfigPath = new URL("../../../wrangler.json", import.meta.url)

const config = {
  name: "vitehub-chat-devtools",
  compatibility_date: "2026-05-26",
  assets: {
    directory: "./playground/vite/dist/client",
    not_found_handling: "single-page-application",
  },
}

await writeFile(rootConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
