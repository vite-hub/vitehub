# Workspace

Use Workspace for persistent file-tree state, Sources, access rules, snapshots, diffs, and sessions. A Workspace is the boundary for file authority and write-back.

Read the [Workspace guide](https://vitehub.dev/raw/docs/workspace.md), then [Get started](https://vitehub.dev/raw/docs/workspace/get-started.md), [Configure](https://vitehub.dev/raw/docs/workspace/configure.md), [Server API](https://vitehub.dev/raw/docs/workspace/server-api.md), or [Hosts](https://vitehub.dev/raw/docs/workspace/hosts.md).

Set the root, provider, mode, and write rules explicitly. Mount only the Sources an invocation needs. A mounted Source is context and does not imply write access.

Prove read, scoped write, diff, and restart or provider recovery. Inspect snapshots and generated Workspace state before relying on persistence.
