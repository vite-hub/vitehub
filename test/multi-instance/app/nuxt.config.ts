export default {
  compatibilityDate: "2026-11-01",
  modules: ["vite-hub/nuxt"],
  nitro: { preset: "node-server" },
  runtimeConfig: { multiInstanceBuildRedis: process.env.REDIS_URL ? "set" : "unset" },
  vitehub: {
    agent: false,
    blob: { driver: "fs", base: process.env.MULTI_INSTANCE_SHARED_BLOB_DIR },
    database: true,
    kv: process.env.REDIS_URL ? { driver: "redis" } : true,
    host: "node",
    queue: true,
    rateLimit: true,
    realtime: { driver: "memory" },
    schedule: { runtime: { driver: "process", intervalMs: 1000 } },
    workflow: { driver: "openworkflow" },
  },
}
