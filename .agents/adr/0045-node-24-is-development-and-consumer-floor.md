# Node 24 Is Development and Consumer Floor

ViteHub uses Node 24 as both the development runtime and the published consumer runtime floor. The Vite+ environment pin and package `engines.node` declarations should agree so ViteHub does not advertise runtime combinations that its packages, examples, CLI behavior, and generated server code do not validate.

## Considered Options

- Pinning Node 24 only for development while keeping a broader consumer `engines.node` range was rejected because it would imply support for older runtime combinations ViteHub is no longer optimizing for.
- Keeping `tsx` as a TypeScript script runner was rejected as a default because Node 24 can own local script execution where scripts are migrated to runnable JavaScript or Node-supported TypeScript paths.

## Consequences

Package manifests, CI, examples, and development instructions should converge on Node 24. Script and test helpers that only exist to compensate for older Node runtimes should be removed or rewritten as part of the Vite+ migration.
