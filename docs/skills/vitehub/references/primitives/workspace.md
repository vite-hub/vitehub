# Workspace

Use Workspace for persistent file-tree state, Sources, access rules, snapshots, diffs, and sessions. A Workspace is the boundary for file authority and write-back.

Read the [Workspace guide](https://vitehub.dev/docs/workspace), then [Get started](https://vitehub.dev/docs/workspace/get-started), [Configure](https://vitehub.dev/docs/workspace/configure), [Server API](https://vitehub.dev/docs/workspace/server-api), or [Hosts](https://vitehub.dev/docs/workspace/hosts).

Set the root, provider, mode, and write rules explicitly. Mount only the Sources an invocation needs. A mounted Source is context and does not imply write access.

Prove read, scoped write, diff, and restart or provider recovery. Inspect snapshots and generated Workspace state before relying on persistence.
