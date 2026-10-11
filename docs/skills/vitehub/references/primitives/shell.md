# Shell

Use Shell to run bounded Unix-like commands with explicit filesystem, process, network, timeout, and policy access.

Read the [Shell guide](https://vitehub.dev/docs/shell), then [Get started](https://vitehub.dev/docs/shell/get-started), [Configure](https://vitehub.dev/docs/shell/configure), [Server API](https://vitehub.dev/docs/shell/server-api), or [Limits and errors](https://vitehub.dev/docs/shell/limits-and-errors).

Treat command text, working directory, environment, and network access as authority. Prefer an allowlist and a small working directory. Resource bounds and cancellation are part of the run contract.

Prove a permitted command, a rejected command, timeout, cancellation, output limit, and cleanup.
