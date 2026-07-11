# Cloudflare Artifacts as a Workspace Store

## Decision

Complete the existing `cloudflare-artifacts` Workspace Store as an explicit, opt-in Cloudflare provider. Keep the current public provider options, keep Cloudflare's default Store as `memory`, and keep Agent delivery attachments on Blob/R2 or channel-native uploads.

The intended contract is:

- one Cloudflare Artifacts repository per named ViteHub Workspace by default;
- the Cloudflare Artifacts binding for repository lifecycle and repo-scoped tokens;
- Git over HTTPS inside the Worker for file reads, writes, commits, and pushes;
- a successful `workspace.snapshot()` as the durable Git commit boundary;
- the pushed Git commit SHA as `WorkspaceSnapshot.id`.

This direction follows Cloudflare's repository model and first-party Worker example. Artifacts stores versioned file trees behind a Git-compatible interface and recommends separate repositories for agents, sessions, or applications that need isolated lifecycles. ([Artifacts overview](https://developers.cloudflare.com/artifacts/); [repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/); [best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/))

Keep the provider opt-in because Artifacts remains a closed beta and is unavailable on Workers Free. That makes `memory` the honest general Cloudflare default. ([Artifacts overview](https://developers.cloudflare.com/artifacts/); [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/))

This implementation branch was rebased onto `origin/main` at `7a88858a83499a11399a02fdf59114a123a83d47` before final verification.

## Evidence

### The Cloudflare primitive fits Workspace

An Artifacts namespace is a top-level environment, tenant, or sharding boundary. Repositories are unique inside a namespace, and namespaces are created when their first repository is created. A Wrangler binding declares both the Worker binding name and namespace:

```json
{
  "artifacts": [
    {
      "binding": "WORKSPACE_ARTIFACTS",
      "namespace": "vitehub"
    }
  ]
}
```

The Workers binding is the repository control plane. `create()` returns repository metadata plus an initial token; `get()` returns a repository handle that can mint scoped tokens. The data plane remains Git. Cloudflare's first-party Worker example uses `isomorphic-git`, an in-memory filesystem, and Git smart HTTP to commit and push file trees. ([Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/); [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/))

This maps directly to the existing `WorkspaceStore` contract for file operations, snapshots, diffs, and hidden metadata. ViteHub already exposes `CloudflareArtifactsWorkspaceStoreOptions` with `binding`, `namespace`, `repo`, `repoPrefix`, and `branch`, so another Cloudflare-specific Workspace abstraction is unnecessary.

Artifacts allows repositories much larger than a Worker can safely clone. Worker isolates have a 128 MB memory limit, while an Artifacts repository can be up to 10 GB. A Worker adapter that buffers a checkout must state a deliberately small-Workspace envelope. ArtifactFS is the later large-repository path for a sandbox, container, or VM with FUSE support. ([Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/); [Workers limits](https://developers.cloudflare.com/workers/platform/limits/); [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/))

### The existing support was incomplete

The public provider literal and runtime adapter existed, but production-shaped Workspace builds did not add the Artifacts binding to Cloudflare Provider Output. Selecting a supported Store could therefore produce a Worker without the binding needed at runtime.

The prototype adapter also had correctness gaps:

1. Every `binding.get()` failure entered repository creation instead of restricting creation to Cloudflare's not-found error (`10200`).
2. It modeled `create()` as a repository handle even though Cloudflare returns a distinct creation result, and it discarded token expiry metadata.
3. Every clone failure was treated as an empty repository, masking authentication, availability, and corruption failures. Cloudflare's `source` field also matters: imported and forked repositories can contain history while `lastPushAt` is still null.
4. A failed push left a clean local commit, so retrying `snapshot()` could falsely report success without pushing.
5. A clone did not initialize the diff baseline, so existing remote files appeared locally added.
6. `mediaType` and Workspace metadata were lost, which can break Source-backed write protection after a fresh Worker instance.
7. Only mock-level adapter tests existed; the live Cloudflare Workspace smoke still used `memory`.

Cloudflare distinguishes missing repositories (`10200`) from create races where a repository already exists (`10201`). Repository acquisition should create only after the former and recover the latter by loading the concurrent winner. ([Artifacts errors](https://developers.cloudflare.com/artifacts/api/errors/))

### Artifacts is not public attachment hosting

Artifacts repositories and their scoped tokens are private Git storage. The Workers binding manages repositories and tokens; Git clients use repository credentials, while REST file access uses a Cloudflare API token. This is not a stable public attachment origin. ([authentication](https://developers.cloudflare.com/artifacts/guides/authentication/); [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/))

ViteHub Agent delivery artifacts have a different job: turn a Workspace-relative file into a URL or channel-native attachment. Keep that on `@vite-hub/blob` with R2/Vercel Blob, or on the channel adapter.

## Implementation seam

1. Generate the exact Artifacts binding when the module-level Workspace Store selects `cloudflare-artifacts`. Merge by binding name, preserve app-owned entries, and remove only Workspace-owned output when the selection changes.
2. Keep `binding` and `namespace` at the module/host boundary. Reject a definition-level custom binding or namespace that cannot be materialized rather than deploying a broken Worker silently.
3. Use Cloudflare's actual create and repository-handle shapes. Create only on not-found, recover an already-exists race, initialize only a repository with neither a push nor an import/fork source, and renew tokens before expiry.
4. Serialize mutations, retain a pending local commit across transient push failure, and map non-fast-forward updates to a clear Workspace conflict.
5. Initialize the baseline after load and persist Workspace file metadata in a hidden committed sidecar.
6. Document the Worker memory envelope and keep Wrangler plus generated `wrangler.json` as the inspection surface.

## Rejected alternatives

- Do not flip Cloudflare's default from `memory` to Artifacts while access requires a closed beta and paid Workers plan.
- Do not replace the versioned Store with raw R2 objects; ViteHub would need to rebuild history, refs, conflicts, and Git handoff.
- Do not call the Artifacts REST API from the Worker as the primary data plane; the binding plus Git keeps access repository-scoped.
- Do not expose Artifacts remotes or tokens as delivery URLs.
- Do not start with ArtifactFS inside the Worker; it requires a FUSE-capable runtime.
- Do not add a second Cloudflare Workspace API when the existing Store options already express the contract.

## Proof boundary

The package-level proof should cover generated bindings, preservation of unrelated app bindings, provider changes, create races, non-not-found errors, existing, empty, and imported/forked repositories, token renewal, remote conflicts, push retry, ignored files, mutation ordering, initial diff state, and metadata round trips.

A real closed-beta deployment still needs to prove write -> snapshot -> fresh isolate -> read, confirm that the snapshot id is the pushed commit, and confirm that a concurrent stale writer receives an explicit conflict. That live account-level proof is separate from the deterministic pull-request suite because this repository does not carry Cloudflare beta credentials.
