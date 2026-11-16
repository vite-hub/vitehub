import { authTokenVariable, defaultDatabaseLocations } from "@vite-hub/database/connect"
import { forgeEnv } from "@vite-hub/forge"
import { describe, expect, it } from "vitest"

import { commentsDeploymentEnv } from "../src/deployment-env.ts"
import { githubLoginEnv } from "../src/runtime/github-login.ts"

const names = (entries: ReturnType<typeof commentsDeploymentEnv>) => entries.map(entry => entry.names)

describe("commentsDeploymentEnv", () => {
  it("names the GitHub sign-in, VITEHUB_SECRET, and Forge credentials of an app without Auth, all optional", () => {
    const entries = commentsDeploymentEnv({}, { host: "node" })
    const { webhookSecret: _webhookSecret, ...forge } = forgeEnv.github
    expect(names(entries)).toEqual([
      [githubLoginEnv.clientId],
      [githubLoginEnv.clientSecret],
      ["VITEHUB_SECRET"],
      ...Object.values(forge).map(field => field.names),
    ])
    expect(entries.every(entry => !entry.required && entry.owners?.[0] === "comments")).toBe(true)
    expect(entries.filter(entry => entry.secret).map(entry => entry.names[0])).toEqual([
      "VITEHUB_GITHUB_CLIENT_SECRET",
      "VITEHUB_SECRET",
      "VITEHUB_GITHUB_PRIVATE_KEY",
      "VITEHUB_GITHUB_TOKEN",
    ])
  })

  it("skips the GitHub sign-in when the app has Auth", () => {
    expect(names(commentsDeploymentEnv({ auth: true }, { host: "cloudflare" }))[0]).toEqual(forgeEnv.github.appId.names)
  })

  it("requires the URL variable of comments({ database: \"env:…\" }) with its optional token", () => {
    const entries = commentsDeploymentEnv({ auth: true, standalone: { database: "env:COMMENTS_DATABASE_URL" } }, { host: "cloudflare" }).slice(-2)
    expect(entries).toEqual([
      { names: ["COMMENTS_DATABASE_URL"], required: true, secret: true, hasDefault: false, owners: ["comments"] },
      { names: [authTokenVariable("COMMENTS_DATABASE_URL")], required: false, secret: true, hasDefault: false, owners: ["comments"] },
    ])
  })

  it("requires a default database URL outside Cloudflare, where no D1 binding is the fallback", () => {
    const node = commentsDeploymentEnv({ auth: true, standalone: {} }, { host: "node" }).slice(-3)
    expect(node[0]).toMatchObject({ names: defaultDatabaseLocations.urls, required: true })
    expect(node.slice(1).map(entry => entry.names[0])).toEqual(defaultDatabaseLocations.urls.map(authTokenVariable))
    expect(commentsDeploymentEnv({ auth: true, standalone: {} }, { host: "cloudflare" }).at(-3)).toMatchObject({ required: false })
    expect(commentsDeploymentEnv({ auth: true, standalone: { database: "d1:COMMENTS" } }, { host: "cloudflare" })).toHaveLength(7)
  })
})
