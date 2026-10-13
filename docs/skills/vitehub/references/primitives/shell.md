# Shell

Use Shell to run bounded Unix-like commands with explicit filesystem, process, network, timeout, and policy access.

Read the [Shell guide](https://vitehub.dev/raw/docs/shell.md), then [Get started](https://vitehub.dev/raw/docs/shell/get-started.md), [Configure](https://vitehub.dev/raw/docs/shell/configure.md), [Server API](https://vitehub.dev/raw/docs/shell/server-api.md), or [Limits and errors](https://vitehub.dev/raw/docs/shell/limits-and-errors.md).

Treat command text, working directory, environment, and network access as authority. Prefer an allowlist and a small working directory. Resource bounds and cancellation are part of the run contract.

Prove a permitted command, a rejected command, timeout, cancellation, output limit, and cleanup.
