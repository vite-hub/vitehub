# Vercel runtime packages bench

This bench builds `fixtures/vercel-runtime-packages` for Vercel. The fixture uses Agent, Blob, Workflow, and Workspace. Each of these features adds runtime packages to `.vercel/output/functions/__server.func/node_modules`.

For each build, the bench records:

- the build time,
- the runtime package passes, the packages copied, the files copied, and the time spent in the passes,
- the CPU time of the build process,
- a SHA-256 hash of each file in `__server.func`.

Build the ViteHub packages first. Then run:

```sh
node scripts/bench-vercel-runtime-packages/run.mjs --runs 3 --out /tmp/after.json
```

Each run builds in the same temporary directory and keeps the fixture file times, so that two runs of the same build write the same files. The bench fails if two runs write different files. It also fails if a copied `@vite-hub/*` file is different from the file in its package build.

To compare two results, run:

```sh
node scripts/bench-vercel-runtime-packages/run.mjs --compare /tmp/before.json /tmp/after.json
```

The compare mode exits with 1 when the `__server.func` file lists are different or when a third-party file is different. It ignores the content hash in chunk names. It counts the ViteHub bundle and package files but does not compare them, because they change whenever ViteHub source changes.

`count-hook.mjs` is loaded with `node --import` in the build process. It counts the work in the staged `node_modules` directories that `updateRuntimePackageDirectory` creates.
