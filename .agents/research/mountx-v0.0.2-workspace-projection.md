# MountX v0.0.2 as a ViteHub Workspace projection

Research snapshot: 2026-07-30. Sources are limited to MountX and ViteHub's repositories, release metadata, source, documentation, issues, pull requests, and the npm registry.

## Verdict

MountX v0.0.2 is ready for an experimental integration: expose an existing ViteHub Workspace Session as a MountX `FsDriver`, and use that projection automatically for trusted local Box Sessions when `mountx/auto` finds a supported transport. Sources, scopes, rules, snapshots, persistence, diffing, and explicit commit remain with ViteHub.

The public surface is an optional `@vite-hub/workspace/mountx` adapter, `createWorkspaceDriver(session, { readOnly })`. It does not restore `Workspace.mount()` or make MountX the Workspace store. A manual caller can pass the driver to `mountx/auto`, `mountx/9p`, `mountx/nfs`, or `mountx/s3`, and must still explicitly unmount, commit if desired, and close the Workspace Session. The hosted Session integration owns that lifecycle when a trusted-host Box exposes its local path; remote Box providers and hosts without a supported transport retain the copy-based path.

## What v0.0.2 changes

`mountx@0.0.2` was published to npm and released on GitHub on 2026-07-30. The release tag resolves to commit `bbb926d`, and the package publishes explicit `mountx/9p` and `mountx/s3` entry points alongside the existing root, auto, FUSE, NFS, and driver entry points. The changelog identifies three new transports or protocol surfaces: an S3 gateway, 9P2000.L, and NFSv4.1 alongside NFSv3. [Release](https://github.com/pithings/mountx/releases/tag/v0.0.2), [tagged changelog](https://github.com/pithings/mountx/blob/v0.0.2/CHANGELOG.md#L4-L44), [tagged package exports](https://github.com/pithings/mountx/blob/v0.0.2/package.json#L19-L57), [npm registry metadata](https://registry.npmjs.org/mountx/0.0.2)

More importantly for adoption, v0.0.2 contains the correctness fixes that were missing from v0.0.1:

- FUSE now copies decoder bytes retained beyond the receive turn, preventing pooled `Buffer` reuse from corrupting delayed writes. [PR #2](https://github.com/pithings/mountx/pull/2)
- The unstorage driver now preserves live open-file identity across rename and does not lose or resurrect buffered writes during flush and close. [PR #3](https://github.com/pithings/mountx/pull/3)
- `createLoopback().writeFile()` now completes legitimate short writes and rejects impossible progress instead of truncating data or hanging. [PR #4](https://github.com/pithings/mountx/pull/4)

All three pull requests are merged, and the wider correctness and performance sweep tracked in issue #1 is closed as complete. That sweep also bounded transport memory growth and teardown, removed NFS head-of-line blocking, and reduced loopback and remote-store overhead; its paired measurements include NFS calls queued behind a slow operation falling from 1502 ms to 1 ms, NFS sequential reads rising from 325 MiB/s to 977 MiB/s, and loopback stat walks rising from 846/s to 2305/s. These are upstream measurements rather than ViteHub benchmarks, but they remove concrete transport risks that made v0.0.1 unsuitable as a dependency. [Completed review sweep](https://github.com/pithings/mountx/issues/1)

MountX remains alpha and unaudited. Its own README warns that every program on the machine can reach a mounted driver, so v0.0.2 moves the dependency from “known correctness blocker” to “reasonable opt-in experiment,” not to an implicit production default. [README warning](https://github.com/pithings/mountx/blob/v0.0.2/README.md#L3-L7)

## Benefits for ViteHub

### One projection adapter unlocks ordinary tools

MountX deliberately accepts a structural subset of `node:fs/promises`: only `stat`, `readdir`, and `open` are required, while mutation, symlink, permission, timestamp, and other capabilities are explicit and unsupported operations fail instead of being faked. That gives ViteHub one concrete boundary to implement and test, after which editors, CLIs, build tools, harnesses, and agents can consume a Workspace through a real path instead of learning Workspace methods. [Driver contract](https://github.com/pithings/mountx/blob/v0.0.2/src/types.ts#L177-L216), [driver capability rules](https://github.com/pithings/mountx/blob/v0.0.2/docs/1.guide/3.drivers/2.custom.md#L119-L177)

This removes an extra host mirror for projected sessions. ViteHub's current hosted Session resets and materializes the Workspace into a host directory, reads and hashes the host tree for a baseline, rescans it for every diff, and copies accepted changes back into the Workspace. A driver over an already-open transactional Session lets MountX route filesystem calls directly to that Session, so the projection itself no longer needs a second file tree or a copy-back pass. [Current host materialization](https://github.com/vite-hub/vitehub/blob/6cf6361b8ae4dca3bf0c9a2d351d3e148b32bf5d/packages/workspace/src/session/host.ts#L232-L320), [current diff and commit path](https://github.com/vite-hub/vitehub/blob/6cf6361b8ae4dca3bf0c9a2d351d3e148b32bf5d/packages/workspace/src/session/host.ts#L327-L447)

That does not remove all eager copying yet: ViteHub's basic Session currently copies the selected Workspace entries into an in-memory overlay when the Session opens. The first integration removes projection-specific materialization; a later lazy Session/store design would be required to eliminate the initial Workspace-to-Session copy. [Current basic Session initialization](https://github.com/vite-hub/vitehub/blob/6cf6361b8ae4dca3bf0c9a2d351d3e148b32bf5d/packages/workspace/src/session/basic.ts#L25-L39)

### The same driver can reach local hosts and VM guests

`mountx/auto` now probes and chooses FUSE, then 9P, then NFS on Linux, while macOS uses NFS. It loads only the selected protocol stack and exposes the selected transport as a discriminant on the returned mount. ViteHub therefore does not need its own host matrix or provider-specific mount facade. [Auto transport policy](https://github.com/pithings/mountx/blob/v0.0.2/src/auto.ts#L1-L55), [auto probe and selection](https://github.com/pithings/mountx/blob/v0.0.2/src/auto.ts#L270-L309)

The new 9P server is the most useful architectural addition for Box-style execution. A Linux guest can mount a host-served Workspace over a kernel 9P client with no ViteHub agent, shared-folder daemon, or guest additions. 9P preserves real open state, so `close()` and `fsync()` reach the driver and an unlinked open file remains usable; that is a better fit for transactional session buffers than NFSv3. [9P semantics](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/3.9p.md#L53-L64), [standalone 9P server](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/3.9p.md#L178-L226)

The VM guide demonstrates the intended boundary directly: serve on the host, mount inside the guest, and install nothing in the guest. QEMU can reach a loopback-bound 9P server through its default `10.0.2.2` route with no privileged host network setup. Firecracker lacks a 9P client but includes NFSv4.1, so v0.0.2's new NFS version provides the corresponding microVM path. [VM architecture and host requirements](https://github.com/pithings/mountx/blob/v0.0.2/docs/1.guide/5.vms.md#L6-L18), [QEMU recipe](https://github.com/pithings/mountx/blob/v0.0.2/docs/1.guide/5.vms.md#L20-L61), [Firecracker NFSv4.1 path](https://github.com/pithings/mountx/blob/v0.0.2/docs/1.guide/5.vms.md#L99-L140)

This could eventually replace ViteHub's full pre-run materialization and post-run capture for a single isolated VM: the guest sees the transactional Session live, ViteHub observes writes immediately, and `session.commit()` remains the acceptance boundary. It should begin as an explicit Box/provider choice, because the network and multi-client limits below are part of the contract.

### S3 is useful as a secondary interoperability surface

`mountx/s3` can serve one or more drivers to `rclone`, AWS CLI/SDK clients, or presigned URLs without a kernel mount. With credentials it verifies strict SigV4 and can bind beyond loopback; without credentials it refuses non-loopback binds. [S3 gateway shape](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/5.s3.md#L6-L34), [S3 bind and authentication policy](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/5.s3.md#L90-L97)

That can be useful for bounded artifact transfer or a provider whose native client is S3-shaped, but it should not define general Workspace semantics. The gateway drops symlinks, permissions, access time, and content type, implements a deliberate subset of S3, and writes objects in place, so a failure after the first byte can leave a partial object. [S3 semantic boundary](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/5.s3.md#L99-L127), [unsupported S3 surface](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/5.s3.md#L238-L242)

## Required boundaries and caveats

- ViteHub must retain Workspace naming, Source composition, source scopes, rules and hooks, snapshots, stores, publish behavior, and explicit Session commit. MountX describes itself as transport plumbing rather than a filesystem; the driver remains the filesystem. [MountX mental model](https://github.com/pithings/mountx/blob/v0.0.2/docs/1.guide/0.index.md#L35-L57), [what MountX is not](https://github.com/pithings/mountx/blob/v0.0.2/docs/1.guide/0.index.md#L77-L83)
- A mount must be scoped to one Workspace Session and one intended consumer. 9P accepts multiple clients, but locks are grant-all and rename serialization is per connection, so concurrent guests do not receive a cross-client transactional guarantee. [9P multi-client limits](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/3.9p.md#L169-L176)
- Keep 9P and NFS on a private socket or isolated loopback/tap network. Neither protocol authenticates the client, and NFS's `exportPath` is only a starting point rather than confinement; ViteHub must scope the driver itself to the allowed Session paths. [9P security boundary](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/3.9p.md#L91-L121), [NFS driver scoping](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/4.nfs.md#L153-L173), [NFS remote warning](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/4.nfs.md#L236-L249)
- Default 9P caching to `none` when ViteHub or another process can mutate the Session, because 9P has no invalidation channel. Use one guest per Session until MountX has cross-client locks and rename coordination. [9P cache rule](https://github.com/pithings/mountx/blob/v0.0.2/docs/2.transports/3.9p.md#L146-L150)
- The adapter must expose only capabilities ViteHub really supports. In particular, it should not claim durable handles, atomic rename, permissions, timestamps, or symlinks unless the Session contract can preserve them end to end.
- Unmount before closing the Session, and close the Session even when unmount or the consumer fails. The caller, not a hidden Workspace method, should decide whether to commit.

## Implemented pull-request scope

1. Add `mountx@0.0.2` as a pinned Workspace package dependency and publish an optional `@vite-hub/workspace/mountx` subpath.
2. Export a native Workspace driver that supports `{ readOnly: true }` and preserves empty directories, special filenames, symlinks, executable metadata, truncation, and live open-file identity across rename.
3. Prove the driver through MountX's in-process `createLoopback()` boundary: read, create, write, rename, remove, symlink, read-only refusal, Session isolation before commit, and persistence after explicit commit. This exercises the same normalization and capability layer as a mount without requiring FUSE or root in CI. [Loopback testing contract](https://github.com/pithings/mountx/blob/v0.0.2/docs/1.guide/3.drivers/2.custom.md#L187-L204)
4. Let trusted-host Box Sessions expose a safe physical path and automatically replace hosted Workspace materialization with `mountx/auto` projection when a local transport is available.
5. Keep the existing materialization path for attached Sessions, remote Box providers, and hosts where MountX cannot mount. Automatic VM transport selection remains deferred until a provider-specific proof measures startup, I/O, teardown, and failure behavior with one isolated guest.

This captures v0.0.2's immediate value in both public composition and ViteHub's local execution path without changing Workspace ownership or forcing MountX onto remote providers.

## Live repository and pull-request state

- MountX `main` was `09dfeea6bec2c96cede3840ad4fbe27f6d2062c1` at this snapshot. It is three documentation/automation commits ahead of the v0.0.2 release commit, so the release tag remains the implementation reference for this work. [Current MountX head](https://github.com/pithings/mountx/commit/09dfeea6bec2c96cede3840ad4fbe27f6d2062c1), [v0.0.2-to-main comparison](https://github.com/pithings/mountx/compare/v0.0.2...main)
- ViteHub `origin/main` and the clean integration worktree were both `6cf6361b8ae4dca3bf0c9a2d351d3e148b32bf5d` before implementation changes. [Current ViteHub head](https://github.com/vite-hub/vitehub/commit/6cf6361b8ae4dca3bf0c9a2d351d3e148b32bf5d)
- MountX PRs [#2](https://github.com/pithings/mountx/pull/2), [#3](https://github.com/pithings/mountx/pull/3), and [#4](https://github.com/pithings/mountx/pull/4) are merged and included in v0.0.2.
- `mountx/exec`, which would run one child with a driver visible inside an unprivileged user namespace rather than as a host-global mount, is not part of v0.0.2 or current `main`. Its original PR [#9](https://github.com/pithings/mountx/pull/9) is closed without merge and the reduced replacement [#10](https://github.com/pithings/mountx/pull/10) is still a draft. The proposed ViteHub driver adapter would compose with that surface later, but this pull request must not depend on it.
- ViteHub PR [#864](https://github.com/vite-hub/vitehub/pull/864), which removed the placeholder `Workspace.mount()` contract, is merged. The v0.0.2 integration should preserve that decision by adding an explicit adapter rather than recreating a method that hides transport and lifecycle.
