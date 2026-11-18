---
title: Env, secret, and Email commands
description: Check Server Env for a stage, generate and derive app secrets and Console keys, and read the Email development outbox with the vitehub CLI.
navigation.title: Env and Email
navigation.order: 8
navigation.group: Commands
icon: i-lucide-key-round
---

These commands check your configuration before a deploy, make your app's secrets, and show the email it sent in development. `env` and `secret` need no dev server.

## Inspect Server Env

These commands report the status of declared Server Env values, without the values.

```bash [Terminal]
pnpm vitehub env inspect [--stage <name>] [--json]
pnpm vitehub env check [--stage <name>] [--json]
```

Both load the Vite config in the stage mode, with `.env.<stage>` files, and process values win. They list each declared variable with status, source, and required and secret flags. `--json` also lists the host variable `names` of each env declaration, in read order. `env check` exits with status `1` when Server Env would fail to load, so it can gate CI or deploys.

`env status` asks the running app instead of a local stage, through the `env.inspect` [operation](/docs/console/operations). Pass `--url` to check a deployment:

```bash [Terminal]
pnpm vitehub env status --url https://my-app.example.com
```

It returns `ok` and, for each declaration, the status, the `names` it reads, the `name` that supplied the value, and the required, secret, and blocking flags. Values never leave the app.

## Check and push host env

`vitehub env diff` and `vitehub env push` compare and set the variables that the deployed app reads. They read the names of the last build in `deployment.json` and the target of the host in `.vitehub/link.json`, and they run the host CLI with your login. Neither loads the project config.

```bash [Terminal]
pnpm vitehub env diff [--host <host>] [--to github [--repo <owner/name>] [--environment <name>]] [--stage <name>] [--json]
pnpm vitehub env push [--host <host>] [--to github [--repo <owner/name>] [--environment <name>]] [--stage <name>] [--only <NAME>]... [--yes] [--json]
```

| Flag | What it does |
| --- | --- |
| `--host` | the link target to use. Without it, the default target. |
| `--stage` | `production` (the default) or `preview`. A stage selects the host environment and the `.env.<stage>` file. |
| `--only` | push only these names. Repeat it for more names. |
| `--yes` | push without the question. Without a terminal, `env push` needs it and exits with `2` and a `rerun`. |

When the build output for the host is missing, both commands build first, as `vitehub deploy` does. `vitehub deploy` runs the same check before it deploys: see [Check Env before a deploy](/docs/cli/deploy#check-env-before-a-deploy).

`env diff` prints three lists: missing required names, missing optional names, and extra names on the host that no declaration reads. An entry with several names, such as `VITEHUB_GITHUB_TOKEN or GITHUB_TOKEN`, is set when one of them is. Hosts do not return values, so `env diff` compares names only and never says that a value changed. It exits with `1` when a required name is missing, so it can gate a deploy step.

`env push` reads each value from the shell first, then from `.env.<stage>.local`, `.env.<stage>`, `.env.local`, and `.env`, as Vite does. It reads the files in the `envDir` that the build recorded in `deployment.json`, so `envDir: "config"` reads `config/.env.production`, and `envDir: false` reads the shell only. For each entry it pushes the first name in read order that has a value. It does not push an entry without a local value, and it never deletes a host variable. It prints the names and where each value came from, never a value. Values go to the host CLI on stdin, or in an API request body, never in argv, and host CLI errors have the values replaced by `<redacted>`.

A secret from an env file must come from a file that git ignores and does not track. `env push` checks every file that the value reads: its own file, the files of the names that it expands with `$NAME`, and the real path of a symlink. When git cannot answer inside a repository, nothing is pushed. A file outside any git repository passes with a warning, because git cannot commit it. A secret from the shell is not checked.

| Host | Names | Values | Stages |
| --- | --- | --- | --- |
| Cloudflare | `wrangler secret list --name <worker>` | `wrangler secret put <name> --name <worker>`. Every value becomes a Worker secret. The Worker gets the new secret at once. Deploy sends values with the new version instead. | `production` only. A Worker has one set of secrets for every version. |
| Vercel | `vercel env ls --environment <target>` | `vercel env add <name> --environment <target> --force`, with `--sensitive` for a secret | `production` and `preview` |
| Netlify | `netlify env:list --context <context>` | The environment variables API with `NETLIFY_AUTH_TOKEN`, because `netlify env:set` takes the value in argv | `production`, and `preview` as `deploy-preview` |
| Deno | `deno deploy env list` | `deno deploy env load /dev/stdin --replace`, for every context. Deno infers secrecy from the name. Secret declarations with names outside its supported secret suffixes, such as `DATABASE_URL`, are refused before writing; set those in the Deno dashboard. A plain declaration gets `--non-secrets`. | `production` only |

**GitHub Actions secrets**

`--to github` writes the same names to the Actions secrets of a GitHub repository instead of the host. Use it when your own GitHub workflow runs the deploy. It does not create a workflow or set up CI deploy: `vitehub deploy` runs on your machine by default.

```bash [Terminal]
pnpm vitehub env diff --to github
pnpm vitehub env push --to github --yes
pnpm vitehub env push --to github --repo acme/web --environment production --yes
```

| Flag | What it does |
| --- | --- |
| `--repo` | the repository as `owner/name`. Without it, the GitHub repository of the git remote `origin`. |
| `--environment` | write the secrets of this GitHub deployment environment instead of the repository secrets. The environment must exist. |
| `--host` | the build that lists the names. Without it, the default link target. |
| `--stage` | only picks the `.env.<stage>` file. Any stage name works. |

The token comes from `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`, then an installation token of the GitHub App that `@vite-hub/forge` reads when `VITEHUB_GITHUB_APP_ID` is set. It needs write access to the repository secrets. The CLI encrypts each value with the repository public key (a libsodium sealed box) before the request, so the value is not in argv, in output, or in plain text on the wire. GitHub reserves names that start with `GITHUB_`, so an entry such as `VITEHUB_GITHUB_TOKEN or GITHUB_TOKEN` uses `VITEHUB_GITHUB_TOKEN` there.

**Encrypted env files**

To keep values in git, commit a `.env.<stage>` file that [dotenvx](https://dotenvx.com/encryption) encrypted, and keep its private key out of git. `env push` decrypts each `encrypted:` value before it sends it, with the same stdin and redaction rules as a plain value. `vitehub deploy` decrypts the same way after its Env check, before it sets or uploads a value.

```bash [Terminal]
npx @dotenvx/dotenvx encrypt -f .env.production
DOTENV_PRIVATE_KEY_PRODUCTION=<private key> pnpm vitehub env push --yes
```

- The key name follows dotenvx: `DOTENV_PRIVATE_KEY_PRODUCTION` for `.env.production`, `DOTENV_PRIVATE_KEY` for `.env`, or the name that matches the `DOTENV_PUBLIC_KEY_*` line of the file. `env push` reads it from the shell first, then from `.env.keys`. A comma-separated list of keys works, as in `dotenvx rotate`.
- A git-tracked file may hold encrypted secrets. A plaintext secret in a tracked file is still refused.
- `env push` refuses to decrypt when git tracks `.env.keys`, and fails with the key name when the key is missing or wrong.

`vitehub init` ignores `.env*` except `.env.example`. To commit an encrypted stage file, add an exception, and keep `.env.keys` ignored:

```txt [.gitignore]
.env*
!.env.example
!.env.production
```

Vite does not decrypt the file for `vite dev` or `vite build`. Run them through dotenvx when the app reads these values at build time, such as `npx @dotenvx/dotenvx run -f .env.production -- vite build`.

| Code | Cause and fix |
| --- | --- |
| [`SETUP_ENV_FILE_TRACKED`](/docs/cli/diagnostics/setup_env_file_tracked) | A plaintext secret value comes from an env file that git tracks, directly, through `$NAME` expansion, or through a symlink. An `encrypted:` value is allowed. Nothing was pushed. Remove the file from git, ignore `.env*`, and rotate the values that git has seen. The command exits with `3`. |
| [`SETUP_ENV_DECRYPT_FAILED`](/docs/cli/diagnostics/setup_env_decrypt_failed) | The private key cannot decrypt an `encrypted:` value, for example because the file was encrypted with another key. `why` names the dotenvx error code, such as `WRONG_PRIVATE_KEY`. Nothing was pushed. The command exits with `1`. |
| [`SETUP_ENV_KEYS_TRACKED`](/docs/cli/diagnostics/setup_env_keys_tracked) | Git tracks `.env.keys`, so everyone with the repository can decrypt the encrypted env files. Nothing was pushed. Remove the file from git, ignore it, and rotate the keys with `dotenvx rotate`. The command exits with `3`. |
| [`SETUP_ENV_FILE_NOT_IGNORED`](/docs/cli/diagnostics/setup_env_file_not_ignored) | A plaintext secret value comes from an env file that git does not track and does not ignore, so the next commit can add it. Nothing was pushed. Add `.env*` to `.gitignore`. The command exits with `3`. |
| [`SETUP_ENV_GIT_FAILED`](/docs/cli/diagnostics/setup_env_git_failed) | A secret value comes from an env file in a git repository, but `git ls-files` or `git check-ignore` failed, so the CLI cannot tell whether git has the secret. Nothing was pushed. Fix the repository, or set the value in the shell. The command exits with `1`. |
| [`SETUP_ENV_NAME_UNKNOWN`](/docs/cli/diagnostics/setup_env_name_unknown) | `--only` names a variable that the build output does not list. The command exits with `2`. |
| [`SETUP_ENV_PRIVATE_KEY_MISSING`](/docs/cli/diagnostics/setup_env_private_key_missing) | An env file holds `encrypted:` values, and its private key is not in the shell or in `.env.keys`. The fix names the variable, such as `DOTENV_PRIVATE_KEY_PRODUCTION`. Nothing was pushed. The command exits with `2`. |
| [`SETUP_ENV_STAGE_UNSUPPORTED`](/docs/cli/diagnostics/setup_env_stage_unsupported) | The stage is not `production` or `preview`, or the host has no preview environment. The command exits with `3`. |
| [`SETUP_GITHUB_REPOSITORY_REQUIRED`](/docs/cli/diagnostics/setup_github_repository_required) | `--to github` found no `--repo` and no github.com remote named `origin`. The command exits with `2`. |
| [`SETUP_GITHUB_REQUEST_FAILED`](/docs/cli/diagnostics/setup_github_request_failed) | The GitHub API refused a request, for example because the token cannot write secrets or the environment does not exist. The command exits with `1`. |
| [`SETUP_ENV_VALUE_UNSUPPORTED`](/docs/cli/diagnostics/setup_env_value_unsupported) | The host cannot safely store this value, such as a Deno value with a single quote or a line break, a secret name Deno cannot classify, or an existing Netlify variable without Functions scope or secret storage. Set it in the host dashboard. The command exits with `3`.  |

## Pull env values from a Console

A self-hosted Console can keep the env values of each app and stage when its operator turns them on. The hosted Console at console.vitehub.dev never stores values. `vitehub env pull --from console` writes the values of one stage to `.env.<stage>` with the key of `vitehub login`. It needs no project config.

```bash [Terminal]
vitehub env pull --from console                                # production of the only project of the key
vitehub env pull --from console --stage preview --project <id>
vitehub env pull --from console --yes                          # replace the file
```

```txt [Output]
Wrote 2 values of production to .env.production (mode 600): API_TOKEN, DATABASE_URL.
```

- Values retain literal dollar expressions, quotes and newlines when Vite loads the file. If dotenv cannot represent a value faithfully (such as a carriage return or a value containing every quote delimiter), the pull fails before writing the file.
- With `--yes`, the command replaces the file entry; it never writes through a symlink to another file.
- The command prints names, never values. The Console logs each value that it gives out, with the key and the person.
- You must be an owner or admin of the team. A member gets `CONSOLE_ENV_FORBIDDEN`.
- `--project` is needed when the key opens more than one project.
- In a git repository, git must ignore the file and must not track it. The command checks this before it calls the Console.

| Code | Cause and fix |
| --- | --- |
| [`CLI_ENV_FILE_EXISTS`](/docs/cli/diagnostics/cli_env_file_exists) | `.env.<stage>` exists. Pass `--yes` to replace it. A replaced file gets mode `600`. |
| [`CLI_ENV_FILE_NOT_IGNORED`](/docs/cli/diagnostics/cli_env_file_not_ignored) | git tracks `.env.<stage>`, or `.gitignore` does not cover it, so the values could be committed. Add `.env.*` to `.gitignore`, and run `git rm --cached .env.<stage>` for a tracked file. |
| [`CLI_ENV_PULL_FAILED`](/docs/cli/diagnostics/cli_env_pull_failed) | The Console refused the pull. The message has the Console's code, such as `CONSOLE_ENV_VALUES_OFF` when the Console stores no values, or `CONSOLE_ENV_FORBIDDEN` for a member. |

## Generate and derive secrets

```bash [Terminal]
pnpm vitehub secret generate
VITEHUB_SECRET=... pnpm vitehub secret derive myapp:webhooks
pnpm vitehub secret console-key ci
```

`secret generate` prints 32 random bytes as base64 for [`VITEHUB_SECRET`](/docs/env/app-secret). `secret derive <purpose>` prints `deriveSecret(purpose)` for the `VITEHUB_SECRET` in the shell. `secret console-key [name]` prints a new Ed25519 key pair for [signed Console requests](/docs/console/signed-requests): the `VITEHUB_CONSOLE_KEY_<NAME>` line for the app and the `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` line for the CLI. The name defaults to `CLI`. None of them loads the project.

## Inspect the Email development outbox

When the dev server has Email on, read the in-memory outbox from another terminal:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show <id> --html
pnpm vitehub email outbox clear
```

Add `--json` for machine-readable output. The outbox exists only in `vite dev` and empties when the server restarts. `vitehub email preview <template>` renders a `server/emails` template without sending it, in your terminal, with no server.

The commands run `email.outbox-list`, `email.outbox-show`, and `email.outbox-clear` in the `email` Console section, so you need access to that section. `email.outbox-clear` is destructive: `vitehub email outbox clear` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The `email.preview` operation renders a template through the same RPC. The written `vitehub email preview` command renders in your terminal without a server. The generated commands `vitehub email outbox list`, `outbox show`, and `outbox clear` print JSON.
