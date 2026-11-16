// Uploads illustrations/svg/*.svg to the media library of a deployed site, in the `illustrations` folder, and sets the
// alt text of each file from illustrations/alt.json. It calls the same Console routes as the Media page, so it needs a
// signed-in user who may write Content:
//
//   VITEHUB_CONSOLE_COOKIE="<session cookie>" node scripts/upload-illustrations.mjs https://vitehub-docs-demo.maximogarciamtnez.workers.dev
//
// The library stores the same bytes once, so a second run points at the files that exist.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const [url] = process.argv.slice(2)
const cookie = process.env.VITEHUB_CONSOLE_COOKIE
if (!url || !cookie) throw new Error("Pass the site URL and set VITEHUB_CONSOLE_COOKIE.")
const headers = { cookie, "x-vitehub-console": "1", origin: url }
const alt = JSON.parse(readFileSync("illustrations/alt.json", "utf8"))

async function json(response) {
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body?.ok !== true) throw new Error(`${response.status} ${body?.code ?? ""} ${body?.message ?? ""}`)
  return body.value
}

for (const name of readdirSync("illustrations/svg").filter(file => file.endsWith(".svg")).sort()) {
  const form = new FormData()
  form.set("file", new File([readFileSync(join("illustrations/svg", name))], name, { type: "image/svg+xml" }))
  form.set("folder", "illustrations")
  const { file } = await json(await fetch(`${url}/_vitehub/rpc/__upload?section=content`, { method: "POST", headers, body: form }))
  const card = name.replace(/-(light|dark)\.svg$/, "")
  await json(await fetch(`${url}/_vitehub/rpc/__call`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ operation: "media.action", input: { action: "update", section: "content", body: { pathname: file.pathname, alt: alt[card] } } }),
  }))
  console.log(`uploaded ${file.pathname}`)
}
