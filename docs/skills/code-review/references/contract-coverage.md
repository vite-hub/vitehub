# Contract Coverage

Derive the affected contract variants from the diff and its callers. Include only dimensions the change touches:

- configuration forms such as omitted, boolean, shorthand, and object;
- providers, hosts, and frameworks;
- definition, generated artifact, runtime, and consumer representations;
- streaming and non-streaming output, success and failure paths;
- resource or durable-state lifecycle exits.

For each affected cell, find runnable proof or report the exact gap. One passing variant proves only itself. Do not expand the matrix with speculative compatibility.

When the change owns a resource, background task, session, claim, or durable state, cover the applicable success, error, abort, cancellation, timeout, cleanup, restart, and concurrent-reuse transitions at the owning boundary.

For package exports, generated loaders or registries, provider bindings, deployment output, or consumer patches, keep four evidence rows separate:

1. source and package checks;
2. generated-artifact inspection;
3. packed-consumer execution;
4. affected host or provider runtime.

Missing credentials or external infrastructure leave a named unverified row; local evidence does not convert it into a pass.
