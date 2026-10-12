# Blob

Use Blob for binary objects such as uploads, generated files, images, and exports. Choose a driver in Vite config and use the same Blob handle in application code when moving between local and hosted storage.

Read the [Blob guide](https://vitehub.dev/docs/blob) first. Then choose [Get started](https://vitehub.dev/docs/blob/get-started), [Configure](https://vitehub.dev/docs/blob/configure), [Server API](https://vitehub.dev/docs/blob/server-api), or [Hosts](https://vitehub.dev/docs/blob/hosts).

Keep object keys and authorization in application code. Enabling `serve` exposes served objects through a public route by default; set `serve.authorize: true` to require an authenticated session. Treat filesystem Blob storage as one-host storage.

Prove upload, read, list, and delete with the selected driver. For hosted output, inspect the generated binding and verify access rules with a real request.
