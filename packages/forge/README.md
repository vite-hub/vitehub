# @vite-hub/forge

`@vite-hub/forge` is the one Forge client of ViteHub. Channels, Capabilities, Workspaces and Sources use it to reach GitHub, GitLab and Forgejo. It is built on [`forges`](https://forges.link).

Applications do not install this package. They set Server Env, and the `vite-hub` packages that need a Forge read it. This README is the contract for ViteHub packages that depend on it.

## Server Env

Each field reads its `VITEHUB_` name first, then the `FORGES_` name that the `forges` library reads.

| Field | Names |
| --- | --- |
| `github.token` | `VITEHUB_GITHUB_TOKEN`, `FORGES_GITHUB_TOKEN` |
| `github.appId` | `VITEHUB_GITHUB_APP_ID`, `FORGES_GITHUB_APP_ID` |
| `github.privateKey` | `VITEHUB_GITHUB_PRIVATE_KEY`, `FORGES_GITHUB_PRIVATE_KEY` |
| `github.privateKeyPath` | `VITEHUB_GITHUB_PRIVATE_KEY_PATH` |
| `github.installationId` | `VITEHUB_GITHUB_INSTALLATION_ID`, `FORGES_GITHUB_INSTALLATION_ID` |
| `github.appOwner` | `VITEHUB_GITHUB_APP_OWNER` |
| `github.appInstallations` | `VITEHUB_GITHUB_APP_INSTALLATIONS` |
| `github.webhookSecret` | `VITEHUB_GITHUB_WEBHOOK_SECRET`, `FORGES_GITHUB_WEBHOOK_SECRET` |
| `gitlab.baseUrl`, `gitlab.token`, `gitlab.webhookSecret` | `VITEHUB_GITLAB_*`, `FORGES_GITLAB_*` |
| `forgejo.baseUrl`, `forgejo.token`, `forgejo.webhookSecret` | `VITEHUB_FORGEJO_*`, `FORGES_FORGEJO_*` |

`GH_TOKEN` and `GITHUB_TOKEN` are not read. In GitHub Actions, set `VITEHUB_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

## Public imports

| Import | Use |
| --- | --- |
| `forgeEnv` | The Server Env table above. |
| `forgeProvider(connection)` | A `forges` provider for one Forge. Do not return it from a public API. |
| `githubAppCredentials(input)` | GitHub App installation tokens, installation lookup and App metadata. Tokens are cached until one minute before they expire. |
| `readGitHubAppPrivateKey(inline, path)` | Read a PEM key from a value or a file. |
| `forgeErrorStatus(error)`, `ForgeResponseError` | Classify Forge request failures. |
| `withSignal(promise, signal)`, `abortError(signal)` | Cancellation helpers for Forge calls. |

## Diagnostics

| Code | Cause |
| --- | --- |
| `FORGE_R0001` | The GitHub App installation lookup failed, or the App is not installed on the repository. |
