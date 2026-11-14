// Saves the files of authors/, changelog/, and blog/ as drafts in the CMS of a deployed site, then publishes them.
// It runs `vitehub content` against the Console RPC of the site, so it needs a signed-in admin or publisher:
//
//   VITEHUB_CONSOLE_COOKIE="<session cookie>" node scripts/seed-content.mjs https://vitehub-docs-demo.maximogarciamtnez.workers.dev
//
// A document that exists already is saved over its draft. Run it again to restore the seed.
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const url = process.argv[2]
if (!url) throw new Error("Pass the site URL.")
const collections = [["authors", "authors", ".yaml"], ["changelog", "changelog", ".md"], ["blog", "blog", ".md"]]

const vitehub = (...args) => execFileSync("pnpm", ["exec", "vitehub", "content", ...args, "--url", url, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })

for (const [collection, folder, extension] of collections) {
  for (const file of readdirSync(folder).filter(name => name.endsWith(extension)).sort()) {
    const id = file.slice(0, -extension.length)
    vitehub("edit", collection, id, "--file", join(folder, file), "--override-lease")
    console.log(`saved ${collection}/${id}`)
  }
  vitehub("publish", "--collection", collection, "--yes")
  console.log(`published ${collection}`)
}
