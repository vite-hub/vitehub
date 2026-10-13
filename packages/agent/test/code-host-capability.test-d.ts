import { codeHost } from "../src/capabilities.ts"

codeHost()
codeHost({ mode: "write", operations: ["merge"], policy: "allow" })
codeHost({ host: "gitlab", repositories: ["platform/api"], operations: ["read_thread"] })
// @ts-expect-error Write operations require write mode.
codeHost({ operations: ["merge"] })
// @ts-expect-error Read mode does not accept policy.
codeHost({ mode: "read", policy: "allow" })
// @ts-expect-error Credentials come from Server Env.
codeHost({ token: "secret" })
