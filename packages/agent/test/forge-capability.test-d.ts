import { forge } from "../src/capabilities.ts"

forge()
forge({ mode: "write", operations: ["merge"], policy: "allow" })
forge({ forge: "gitlab", repositories: ["platform/api"], operations: ["read_thread"] })
// @ts-expect-error Write operations require write mode.
forge({ operations: ["merge"] })
// @ts-expect-error Read mode does not accept policy.
forge({ mode: "read", policy: "allow" })
// @ts-expect-error Credentials come from Server Env.
forge({ token: "secret" })
