---
title: Forge limits and errors
description: Know how long a Forge installation token lives, and find the cause and the fix of each FORGE error code.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

- A GitHub App installation token expires after one hour. `useForge()` caches it until one minute before that. Pass `refresh: true` to mint a new one.
- `VITEHUB_GITHUB_TOKEN`, GitLab, and Forgejo tokens have no expiry that `useForge()` knows, so `expiresAt` is `undefined`.

## Errors

Operations return `[error, data]`. A configuration that cannot work throws, so you find it at the first call.

### Runtime errors

### FORGE_APP_NOT_INSTALLED

The GitHub App is not installed on the repository. Install the App on it, or set `VITEHUB_GITHUB_INSTALLATION_ID` to an installation that can reach it.

### FORGE_REQUEST_FAILED

A GitHub request failed. `error.cause` has the Forge error. A 401 means that the App ID, the private key, or the token is wrong. Retry after a 5xx or a network error.

### Configuration errors

### FORGE_MISSING_ENV

The env has no credentials for the Forge, or it has only a part of the App credentials. The error names the variables to set.

### FORGE_INVALID_ENV

A variable has a value that cannot work, such as an installation ID that is not a number, or a key path that names a file that does not exist.

### FORGE_MISSING_INSTALLATION

The App has no fixed installation, and the call has no `repository`. Pass `{ repository: 'owner/name' }`, or set `VITEHUB_GITHUB_INSTALLATION_ID`.

### FORGE_NOT_APP

`app()` needs a GitHub App, and the Forge uses a token. Check `forge.auth` before you call `app()`.

### Building block errors

The [building blocks](/docs/forge/server-api#public-imports) that ViteHub packages use throw these codes.

### FORGE_R0001

The GitHub App installation lookup failed, or the App is not installed on the repository.

### FORGE_R0002

`forgeArchive()` was called for a Forge other than GitHub.

### FORGE_R0003

`forgeGitCredentials()` received a base URL that is not HTTP or a repository that is not `owner/name`.

### FORGE_R0004

`forgeBlob()` was called for a Forge other than GitHub.

### FORGE_R0005

`forgeCommitFiles()` received a file mode for a Forge other than GitHub.

### FORGE_R0006

A GitHub-only helper got a provider for another Forge.

### FORGE_R0007

`githubBranchRuleDetails()` got branch rules that are not complete GitHub rulesets or classic protection.

### FORGE_R0009

A GitHub-only helper got a reference that is not a numbered pull request, or an empty input.
