// The harness builds this app once and runs it as three Node instances.
// Blob and Workflow have a shared store set by hand. The other primitives use their Node defaults.
export default {
  compatibilityDate: "2026-11-01",
  modules: ["vite-hub/nuxt"],
  nitro: { preset: "node-server" },
  // The boot check reads this, to prove that the build saw REDIS_URL only in the Redis mode.
  runtimeConfig: { multiInstanceBuildRedis: process.env.REDIS_URL ? "set" : "unset" },
  vitehub: {
    agent: false,
    // run.mjs sets this directory at build time. It stands for a volume that every instance mounts.
    blob: { driver: "fs", base: process.env.MULTI_INSTANCE_SHARED_BLOB_DIR },
    database: true,
    // Redis requires an explicit driver. Without it, KV infers the Postgres Default Database.
    kv: process.env.REDIS_URL ? { driver: "redis" } : true,
    preset: "node",
    queue: true,
    rateLimit: true,
    realtime: { authority: "memory" },
    schedule: { runtime: { driver: "process", intervalMs: 1000 } },
    // OpenWorkflow reads DATABASE_URL when the server starts.
    workflow: { provider: "openworkflow" },
  },
}
