# Blob

<!-- Generated from docs/content/docs/blob/index.md. Edit the agent-only block there. -->

Source page: https://vitehub.dev/raw/docs/blob.md

Use Blob for binary objects such as uploads, generated files, images, and exports. Choose a driver in Vite config and use the same Blob handle in application code when moving between local and hosted storage.

Keep object keys and authorization in application code. Enabling `serve` exposes served objects through a public route by default; set `serve.authorize: true` to require an authenticated session. Treat filesystem Blob storage as one-host storage.

Prove upload, read, list, and delete with the selected driver. For hosted output, inspect the generated binding and verify access rules with a real request.
