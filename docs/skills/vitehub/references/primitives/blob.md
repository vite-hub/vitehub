# Blob

<!-- Generated from docs/content/docs/blob/index.md. Edit the agent-only block there. -->

Source page: https://vitehub.dev/raw/docs/blob.md

Use Blob for binary objects such as uploads, generated files, images, and exports. Turn Blob on with `vitehub add blob`, and pass `--option blob.driver=<driver>` where the host needs an explicit driver. Use the same Blob handle in application code when moving between local and hosted storage.

Keep object keys and authorization in application code. `serve` needs `access: "public"`, which sends every object of the served store to anyone, or `authorize: true`, which requires an authenticated session. `put()` has no per-object `access`. Treat filesystem Blob storage as one-host storage.

Prove upload, read, list, and delete with the selected driver. For hosted output, inspect the generated binding and verify access rules with a real request.
