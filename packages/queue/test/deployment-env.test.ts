import { describe, expect, it } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"
import { queueDeploymentEnv } from "../src/deployment-env.ts"
import { hubQueue } from "../src/vite.ts"

const queue = { secret: true, owners: ["queue"] }

describe("queueDeploymentEnv", () => {
  it("requires QUEUE_POSTGRES_URL on a Node server without a Postgres Default Database", () => {
    expect(queueDeploymentEnv(normalizeQueueOptions({ driver: "postgres" }, { hosting: "node" }))).toEqual([
      { names: ["QUEUE_POSTGRES_URL"], required: true, hasDefault: false, ...queue },
    ])
  })

  it("keeps QUEUE_POSTGRES_URL optional when the jobs borrow the Default Database", () => {
    expect(queueDeploymentEnv({ driver: "postgres", database: "default" })).toEqual([
      { names: ["QUEUE_POSTGRES_URL"], required: false, hasDefault: true, ...queue },
    ])
  })

  it("names the optional QUEUE_REGION on Vercel and nothing on Cloudflare", () => {
    expect(queueDeploymentEnv(normalizeQueueOptions(undefined, { hosting: "vercel" }))).toEqual([
      { names: ["QUEUE_REGION"], required: false, secret: false, hasDefault: false, owners: ["queue"] },
    ])
    expect(queueDeploymentEnv(normalizeQueueOptions(undefined, { hosting: "cloudflare" }))).toEqual([])
    expect(queueDeploymentEnv(normalizeQueueOptions(false))).toEqual([])
  })

  it("resolves the provider of the host through the Vite plugin API", () => {
    expect(hubQueue().api.deploymentEnv({ host: "node" })).toEqual([])
    expect(hubQueue({ driver: "postgres" }).api.deploymentEnv({ host: "node" })[0]).toMatchObject({ names: ["QUEUE_POSTGRES_URL"], required: true })
    expect(hubQueue().api.deploymentEnv({ host: "cloudflare" })).toEqual([])
  })
})
