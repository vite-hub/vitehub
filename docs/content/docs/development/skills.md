---
title: Agent Skills
description: Serve your app's Agent Skills to coding agents through Agent Skills Discovery and MCP.
navigation.order: 32.3
navigation.group: Local tools
icon: i-vitehub-skills
---

An [Agent Skill](https://agentskills.io) is a folder with a `SKILL.md` and optional files, such as `references/` and `assets/`. `vite-hub/skills` serves your app's skills from one list:

| Surface | Path or method | Read by |
| --- | --- | --- |
| Agent Skills Discovery v0.2.0 | `/.well-known/agent-skills/index.json`, `<name>/SKILL.md`, `<name>.tar.gz` | Clients of the v0.2.0 index |
| Agent Skills Discovery v0.1.0 | `/.well-known/skills/index.json`, `<name>/<path>` | `npx skills add https://app.example.com` and Executor |
| MCP Skills extension | `skills/list`, `skills/get`, `resources/list`, `resources/read` for `skill://<name>/<path>` | MCP clients of your MCP server |

It uses only `Request`, `Response`, and Web Crypto, so it runs on every host, also Cloudflare Workers. The [Console](/docs/development/console) endpoint serves the ViteHub skill separately, at `/_vitehub/.well-known/skills`.

## Define the skills

Put each skill in its own folder in `skills/`. The folder name must match the frontmatter `name`:

```md [skills/release/SKILL.md]
---
name: release
description: Ship a release of this app. Use when someone asks to release, tag, or publish.
---

# Release

Read `references/checklist.md` first.
```

Load the files with `import.meta.glob()`, so they are in the bundle and the server needs no file system. `defineSkills()` starts a skill at each `SKILL.md` and adds the files in its folder:

```ts [server/skills.ts]
import { defineSkills } from 'vite-hub/skills'

export const skills = defineSkills(
  import.meta.glob('../skills/**', { query: '?raw', import: 'default', eager: true }),
)
```

A string is UTF-8 text. Pass a `Uint8Array` for a binary file, such as an image. `defineSkill()` makes one skill from paths in its folder, for example from a package:

```ts
import { defineSkill } from 'vite-hub/skills'
import skillMd from 'some-package/skills/some-skill/SKILL.md?raw'

export const someSkill = defineSkill({ 'SKILL.md': skillMd })
```

Both throw a [definition error](#errors) when `SKILL.md`, its `name`, or its `description` is missing, when a path leaves the folder, or when two skills share a name.

## Serve Agent Skills Discovery

`serveSkills(request, skills)` answers requests under `/.well-known/agent-skills/` or `/.well-known/skills/`, and returns `undefined` for other paths. In Nitro or Nuxt, a middleware passes other requests on:

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

The v0.2.0 index has a `digest` per skill:

- One file: `type: "skill-md"` and the digest of its `SKILL.md`.
- More files: `type: "archive"`, a `.tar.gz` with `SKILL.md` at its root, and the archive's digest. File times are fixed, so every server builds the same bytes.

The v0.1.0 index lists each skill's files and a `version`: the first 12 characters of the same digest, which changes when a file changes.

| Option | Default | Use |
| --- | --- | --- |
| `base` | the origin root | The path before `/.well-known/`, such as `/docs` for an app under a base path. Index URLs include it. |
| `cacheControl` | `public, max-age=60` | `Cache-Control` for every answer. |

A path under the two folders that names no skill or file gets `404`. Methods other than `GET` and `HEAD` get `405`.

## Change the list at runtime

Pass a function instead of a list. Each request calls it, so the function can read a setting, such as the skills an admin turned off. These excerpts replace the earlier list and middleware, using your app's `disabledSkillNames()` helper and the middleware imports above:

```ts [server/skills.ts] fragment
import { defineSkills } from 'vite-hub/skills'
import { disabledSkillNames } from './utils/settings'

const all = defineSkills(import.meta.glob('../skills/**', { query: '?raw', import: 'default', eager: true }))

export async function enabledSkills() {
  const disabled = await disabledSkillNames()
  return all.filter(skill => !disabled.has(skill.name))
}
```

```ts [server/middleware/skills.ts] fragment
export default defineHandler(event => serveSkills(event.req, enabledSkills))
```

A skill the function leaves out is missing from every index and from MCP. Files of only left-out skills answer `404`. Nested files stay part of any enclosing skill that is still on. Digests and archives are computed once per skill object, so filter the same objects instead of creating new ones. Clients can cache an answer for the `cacheControl` time, one minute by default.

## Serve skills over MCP

`skillsMcp(skills)` returns MCP Skills extension (SEP-2640, `io.modelcontextprotocol/skills`) results as plain objects, so any MCP server library can use them. It takes the same list or function as `serveSkills()`. `list()`, `get()`, and `read()` results include `resultType: "complete"`, `ttlMs: 0`, and `cacheScope: "private"`, so clients fetch fresh data each time.

| Method | Answers |
| --- | --- |
| `extension` | `io.modelcontextprotocol/skills`, the id the server announces. |
| `list()` | The `skills/list` result: each skill with its `uri`, `frontmatter`, and each file with `uri`, `digest`, and `size`. |
| `get(uri)` | `[error, data]` with the `skills/get` result for `skill://<name>` or `skill://<name>/SKILL.md`. |
| `resources()` | Every skill file for `resources/list`. The `SKILL.md` of a skill has its `description`. |
| `read(uri)` | `[error, data]` with the `resources/read` result for `skill://<name>/<path>`: `text` for a text file, base64 `blob` for bytes. |

`get()` and `read()` return [`SKILL_NOT_FOUND`](#skill_not_found) for a skill or a file that the list does not have. Answer it with the JSON-RPC error `-32602`. This excerpt connects the dynamic list above to an existing [`h3-mcp`](https://github.com/h3js/mcp) server:

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

Read files with `mcpSkills.read(uri)` in your `resources/read` handler. For `resources/list`, wrap the array from `mcpSkills.resources()` in `{ resultType: 'complete', ttlMs: 0, cacheScope: 'private', resources: await mcpSkills.resources() }`.

Nested skill files stay part of the enclosing skill, also in its archive and MCP manifest. A nested skill also gets its own entry, with a URI such as `skill://release/nested/SKILL.md`. Shared files have the same URI in both manifests and appear once in `resources/list`.

## Inspect the skills

The list is plain data: `skill.name`, `skill.description`, `skill.frontmatter`, and `skill.files` with `path`, `mimeType`, `bytes`, and `text`. `skill.path` is the MCP directory path, which keeps enclosing skill names for nested skills. It defaults to `skill.name` for custom skill objects. A `SKILL.md` given as bytes must be valid UTF-8 and is shown as text. `skillDigest(skill)` returns the `sha256:` digest that the v0.2.0 index publishes, and `skillArchive(skill)` returns the `.tar.gz` bytes. From a running app, read the index:

```bash [Terminal]
curl https://app.example.com/.well-known/agent-skills/index.json
```

## Errors

### SKILL_FILE_MISSING

`defineSkill()` got no `SKILL.md`. Add one at the skill root, with `name` and `description` in its frontmatter.

### SKILL_INVALID_FRONTMATTER

`SKILL.md` is not valid UTF-8, does not start with a `---` YAML block, or a frontmatter field is not valid. The `name` has lowercase letters, digits, and single hyphens, at most 64 characters, and equals the folder name in `defineSkills()`. The `description` is a non-empty string of at most 1024 characters. If set, `compatibility` is a non-empty string of at most 500 characters, `metadata` maps strings to strings, and `license` and `allowed-tools` are strings. Unknown fields are kept. The error names the field.

### SKILL_INVALID_PATH

A file path is not a relative path inside the skill. Use paths such as `SKILL.md` or `references/api.md`, without `..`, `.`, empty segments, a leading `/`, or `\`.

### SKILL_DUPLICATE_NAME

`defineSkills()` found two skills with the same `name`. Give each its own name and folder. A list function that returns two with one name serves the first.

### SKILL_NOT_FOUND

`skillsMcp().get()` or `read()` got a URI for a skill or file not in the list, for example one the list function left out. Read `skills/list` or `resources/list` for current URIs.
