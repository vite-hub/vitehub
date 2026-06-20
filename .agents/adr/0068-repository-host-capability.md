# Repository Host Capability

ViteHub adds a **Repository Host Capability** through `repositoryHost()` for provider-hosted repository collaboration objects: repository metadata, issues, Change Requests, Change Request file metadata, comments, and read-only check/status signals. The capability is not raw git, not `gh`, not Source retrieval, not MCP, and not raw provider API passthrough; write mode starts with narrow comment and reaction effects behind normal tool policy while approvals, merges, branch updates, status/check writes, issue edits, repository settings, content, secrets, workflows, and arbitrary provider mutations stay out of this first boundary.

## Considered Options

- `gh()` or `github()` were rejected because the capability is provider-neutral across GitHub, GitLab, Bitbucket, and similar Repository Host Providers.
- `forge()` and `scm()` were rejected because `forge` is not obvious enough and collides with Atlassian Forge, while SCM over-implies raw source control and local git behavior.
- Source, Workspace, MCP, and generic `fetch()` were rejected because they do not own the provider-hosted collaboration object vocabulary or the externally visible write-effect policy.

## Consequences

`repositoryHost()` lives on `@vite-hub/agent/capabilities` and may use an app-owned or runtime-provided Repository Host Client. Provider adapters should preserve native ids, URLs, and raw metadata while exposing ViteHub's normalized repository, issue, Change Request, Change Request file-list, comment, and check/status read vocabulary.
