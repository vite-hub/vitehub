import { defineEventHandler } from "nuxt/server"
import { listReleases } from "../../utils/collections"
import { rss } from "../../utils/feed"

export default defineEventHandler(async event => rss(event, {
  title: "Lumen changelog",
  path: "/changelog",
  description: "Every Lumen release.",
  items: (await listReleases()).map(release => ({ title: `Lumen ${release.version}: ${release.title}`, url: release.url, date: release.date, description: release.title })),
}))
