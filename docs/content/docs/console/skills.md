---
title: Serve Agent Skills
description: Serve your app's Agent Skills to coding agents through Agent Skills Discovery and MCP, and turn each one on or off from the Console.
navigation.title: Served skills
navigation.order: 32
navigation.group: Agents and tools
icon: i-vitehub-skills
---

`vite-hub/skills` serves your app's [Agent Skills](https://agentskills.io), so a coding agent can install them from your site URL or read them over your MCP server. A **skill** is a folder with a `SKILL.md` and optional files, such as `references/` and `assets/`, and one list feeds every surface:

| Surface | Path or method | Read by |
| --- | --- | --- |
| Agent Skills Discovery v0.2.0 | `/.well-known/agent-skills/index.json`, `<name>/SKILL.md`, `<name>.tar.gz` | Clients of the v0.2.0 index |
| Agent Skills Discovery v0.1.0 | `/.well-known/skills/index.json`, `<name>/<path>` | `npx skills add https://app.example.com` and Executor |
| MCP Skills extension | `skills/list`, `skills/get`, `resources/list`, `resources/read` for `skill://<name>/<path>` | MCP clients of your MCP server |

It runs on every host, Cloudflare Workers included. The ViteHub skill itself comes from the [Console](/docs/console) endpoint, at `/_vitehub/.well-known/skills`.

## Define the skills

Put each skill in its own folder in `skills/`, named like the frontmatter `name`:

```md [skills/release/SKILL.md]
---
name: release
description: Ship a release of this app. Use when someone asks to release, tag, or publish.
---

# Release

Read `references/checklist.md` first.
```

Load them with `import.meta.glob()`, so they ship in the bundle and need no file system. `defineSkills()` starts a skill at each `SKILL.md` with the files in its folder:

```ts [server/skills.ts]
import { defineSkills } from 'vite-hub/skills'

export const skills = defineSkills(
  import.meta.glob('../skills/**', { query: '?raw', import: 'default', eager: true }),
)
```

Strings are UTF-8 text, and a `Uint8Array` is a binary file, such as an image. `defineSkill()` makes one skill, for example from a package:

```ts
import { defineSkill } from 'vite-hub/skills'
import skillMd from 'some-package/skills/some-skill/SKILL.md?raw'

export const someSkill = defineSkill({ 'SKILL.md': skillMd })
```

Both throw a [definition error](#errors) when `SKILL.md`, its `name` or its `description` is missing, when a path leaves the folder, or when two skills share a name.

The list is plain data: `skill.name`, `description`, `frontmatter`, and `files` with `path`, `mimeType`, `bytes` and `text`. `skill.path` is the MCP directory path, which keeps the enclosing names of a nested skill and defaults to `skill.name` for custom objects. A `SKILL.md` given as bytes must be valid UTF-8.

## Serve Agent Skills Discovery

`serveSkills(request, skills)` answers under `/.well-known/agent-skills/` and `/.well-known/skills/`, and returns `undefined` elsewhere, so a Nitro or Nuxt middleware passes other requests on:

```ts [server/middleware/skills.ts]
import { defineHandler } from 'h3'
import { serveSkills } from 'vite-hub/skills'
import { skills } from '../skills'

export default defineHandler(event => serveSkills(event.req, skills))
```

An agent then installs a skill from the site URL:

```bash [Terminal]
npx skills add https://app.example.com --skill release
```

| Option | Default | Use |
| --- | --- | --- |
| `base` | the origin root | The path before `/.well-known/`, such as `/docs` for an app under a base path. Index URLs include it. |
| `cacheControl` | `public, max-age=60` | `Cache-Control` for every answer. |

In the v0.2.0 index, a one-file skill has `type: "skill-md"` with the digest of its `SKILL.md`, and a larger one has `type: "archive"`, a `.tar.gz` with `SKILL.md` at its root, and the archive's digest. The v0.1.0 index lists each skill's files and a `version`: the first 12 characters of that digest. `skillDigest(skill)` returns the `sha256:` digest and `skillArchive(skill)` the archive bytes.

An unknown path under the two folders gets `404`, and methods other than `GET` and `HEAD` get `405`. To check a running app, read its index:

```bash [Terminal]
curl https://app.example.com/.well-known/agent-skills/index.json
```

## Change the list at runtime

Pass a function instead of a list, and each request calls it, so it can read a setting, such as the signed-in team's skills. These excerpts replace the list and middleware above, with your app's `teamSkillNames()` helper:

```ts [server/skills.ts] fragment
import { defineSkills } from 'vite-hub/skills'
import { teamSkillNames } from './utils/teams'

const all = defineSkills(import.meta.glob('../skills/**', { query: '?raw', import: 'default', eager: true }))

export async function teamSkills() {
  const names = await teamSkillNames()
  return all.filter(skill => names.has(skill.name))
}
```

```ts [server/middleware/skills.ts] fragment
export default defineHandler(event => serveSkills(event.req, teamSkills))
```

A left-out skill is missing from every index and from MCP, and its files answer `404` unless an enclosing skill is still on. Digests and archives are computed once per skill object, so filter the same objects instead of creating new ones. Clients can cache answers for the `cacheControl` time, one minute by default.

## Turn skills on and off

`skillSettings(skills, { store })` adds a switch to each skill, so you can turn one off while the app runs, without a deploy:

```ts [server/skills.ts]
import { defineSkills, skillSettings } from 'vite-hub/skills'
import { kv } from 'vite-hub/kv'

export default skillSettings(
  defineSkills(import.meta.glob('../skills/**', { query: '?raw', import: 'default', eager: true })),
  { store: kv },
)
```

Skills are on until turned off, so a new skill ships on, and the store keeps only the names of those that are off; [KV](/docs/kv) fits as it is. Serve `settings.enabled`, the list function of the skills that are on, and pass it to `skillsMcp()` too, so a skill that is off is missing everywhere:

```ts [server/middleware/skills.ts]
import { defineHandler } from 'h3'
import { serveSkills } from 'vite-hub/skills'
import settings from '../skills'

export default defineHandler(event => serveSkills(event.req, settings.enabled))
```

With this file at `server/skills.ts`, the Console's **Served skills** section and the CLI change the same switches:

```bash [Terminal]
pnpm vitehub served-skills list
pnpm vitehub served-skills set release false
```

In [`console.authorize`](/docs/console/access), grant `served-skills` to change them or `served-skills:read` to list them. A `server/skills.ts` that exports a plain list, as `skills` or as default, shows every skill on, without switches.

Your own pages use the same object:

| Method | Returns |
| --- | --- |
| `settings.enabled()` | The skills that are on. It rejects with [`SKILL_SETTINGS_UNAVAILABLE`](#errors) when the store fails, so a request fails instead of serving a skill that is off. |
| `settings.list()` | `[error, data]` with each skill and its `enabled` state, for a catalog page with your own rules. |
| `settings.set(name, enabled)` | `[error, data]` after it turns one skill on or off, or `SKILL_NOT_FOUND` for a name that is not in the list. Check who may call it in your route. |

| Option | Default | Use |
| --- | --- | --- |
| `store` | required | An object with `get(key)` and `set(key, names)` that return `[error, data]`, such as `kv` of `vite-hub/kv`, or a small adapter over a Database table. |
| `key` | `vitehub:skills:disabled` | The key of the list of names that are off. The Console's KV section does not edit `vitehub:` keys. |
| `ttlMs` | `60000` | How long an instance reuses what it read. A change applies at once on its own instance, and others see it within `ttlMs` plus the store's delay, such as up to a minute for Cloudflare KV. |

`settings.set()` serializes updates per instance and rereads the store before it writes, so it keeps other instances' changes, but two changes at the same moment on different instances still end with the last write.

## Serve skills over MCP

`skillsMcp(skills)` returns MCP Skills extension results (SEP-2640, `io.modelcontextprotocol/skills`) as plain objects for any MCP server library, from the same list or function as `serveSkills()`. This excerpt adds them to an [`h3-mcp`](https://github.com/h3js/mcp) server:

```ts [server/mcp/skills.ts] fragment
import { invalidParamsError, mcpMethod, parseParams, requireParamString, type ExtensionPlugin } from 'h3-mcp'
import { skillsMcp } from 'vite-hub/skills'
import { enabledSkills } from '../skills'

export const mcpSkills = skillsMcp(enabledSkills)

export const skillsExtension: ExtensionPlugin = {
  id: mcpSkills.extension,
  settings: () => ({ directoryRead: false }),
  methods: ctx => ({
    'skills/list': (req, event) => mcpMethod(ctx, req, event, () => mcpSkills.list()),
    'skills/get': (req, event) => mcpMethod(ctx, req, event, async () => {
      const [error, data] = await mcpSkills.get(requireParamString(parseParams(req.params), 'uri'))
      if (error) throw invalidParamsError(error.message)
      return data
    }),
  }),
}
```


| Method | Answers |
| --- | --- |
| `extension` | `io.modelcontextprotocol/skills`, the id that the server announces. |
| `list()` | The `skills/list` result: each skill with its `uri`, `frontmatter`, and each file with `uri`, `digest` and `size`. |
| `get(uri)` | `[error, data]` with the `skills/get` result for `skill://<name>` or `skill://<name>/SKILL.md`. |
| `resources()` | Every skill file for `resources/list`. The `SKILL.md` of a skill has its `description`. |
| `read(uri)` | `[error, data]` with the `resources/read` result for `skill://<name>/<path>`: `text` for a text file, base64 `blob` for bytes. |

`list()`, `get()` and `read()` results carry `resultType: "complete"`, `ttlMs: 0` and `cacheScope: "private"`, so clients always fetch fresh data. Use `mcpSkills.read(uri)` in your `resources/read` handler, and answer `resources/list` with `{ resultType: 'complete', ttlMs: 0, cacheScope: 'private', resources: await mcpSkills.resources() }`. Answer `SKILL_NOT_FOUND` from `get()` or `read()` with the JSON-RPC error `-32602`.

A nested skill stays part of the enclosing skill, archive and manifest included, and also gets its own entry, such as `skill://release/nested/SKILL.md`. Shared files keep one URI and appear once in `resources/list`.

## Errors

Each code also has its own page under [diagnostics](/docs/development/diagnostics).

| Code | Cause and fix |
| --- | --- |
| `SKILL_FILE_MISSING` | `defineSkill()` got no `SKILL.md`. Add one at the skill root, with `name` and `description` in its frontmatter. |
| `SKILL_INVALID_FRONTMATTER` | `SKILL.md` is not UTF-8, does not start with a `---` YAML block, or has an invalid field, which the error names. `name`: lowercase letters, digits and single hyphens, at most 64 characters, equal to the folder name in `defineSkills()`. `description`: a non-empty string of at most 1024 characters. `compatibility`: a non-empty string of at most 500 characters. `metadata`: strings to strings. `license` and `allowed-tools`: strings. Unknown fields are kept. |
| `SKILL_INVALID_PATH` | A path is not relative and inside the skill. Use paths such as `references/api.md`, without `..`, `.`, empty segments, a leading `/` or `\`. |
| `SKILL_DUPLICATE_NAME` | `defineSkills()` found two skills with one `name`. Give each its own name and folder. A list function that returns two serves the first. |
| `SKILL_NOT_FOUND` | `skillsMcp().get()` or `read()` got a URI that the list does not have, such as a left-out skill; read `skills/list` or `resources/list` for current URIs. `skillSettings().set()` returns it as `skill://<name>` for an unknown name, and `vitehub served-skills set` answers HTTP 404; run `vitehub served-skills list` for the names. |
| `SKILL_SETTINGS_UNAVAILABLE` | The `skillSettings()` store failed, and `cause` holds its error. Check the store binding, then try again. |
| `SERVED_SKILLS_UNAVAILABLE` | HTTP 503: `vitehub served-skills` or the Console section ran without `server/skills.ts`. Add the file and build again. |
| `SERVED_SKILLS_INVALID_EXPORT` | HTTP 500: `server/skills.ts` has no default or `skills` export that is a skill list or `skillSettings()`. Default-export `skillSettings(skills, { store })`, or a list to only show the skills. |
| `SERVED_SKILLS_NO_SETTINGS` | HTTP 409: `served-skills.set` ran, but `server/skills.ts` exports a plain list without switches. Wrap it in `skillSettings(skills, { store })`. |
