# @vite-hub/icons

The ViteHub icon set as an [Iconify](https://iconify.design/) collection with the prefix `vitehub`. It has one 24px icon for each Server Primitive, Console area, and docs area. The Console and vitehub.dev use it, so the same primitive has the same icon in both.

## Use

This package is private: it is not published to npm. `@vite-hub/ui` and the Console bundle it, so a Nuxt app with `vite-hub/nuxt` and Nuxt UI, or with `@vite-hub/docs/nuxt`, has the collection registered. Write the icon name:

```vue
<UIcon name="i-vitehub-kv" />
```

## Icons

Server Primitives use their `vite-hub/<name>` import name.

| Name | Use |
| --- | --- |
| `agent` | Agents |
| `auth` | Auth |
| `blob` | Blob |
| `browser` | Browser |
| `channels` | Channels |
| `cms` | CMS |
| `comments` | Comments |
| `connections` | Connections |
| `content` | Content |
| `database` | Database |
| `decisions` | Decisions |
| `email` | Email |
| `env` | Env |
| `forge` | Forge |
| `forms` | Forms |
| `gateways` | AI Gateways |
| `i18n` | i18n |
| `kv` | KV |
| `logs` | Logs |
| `queue` | Queue |
| `rate-limit` | Rate Limit |
| `realtime` | Realtime |
| `sandbox` | Sandbox and Sandbox Tasks |
| `schedule` | Schedule |
| `shell` | Shell |
| `source` | Source |
| `ui` | UI |
| `workflow` | Workflows |
| `workspace` | Workspace |
| `skills` | Agent Skills |
| `usage` | Token use and cost |
| `docs` | Docs site |
| `start` | Get started |
| `guides` | Guides |
| `development` | Development and the CLI |
| `hosts` | Frameworks and hosts |
| `web-container` | WebContainer |
| `bundle` | Bundle reports |
| `codemods` | Codemods |
| `reference` | Reference |
| `compare` | Comparisons |

## Draw an icon

Each icon is one file in `svg/`. Keep the rules of the set, so a new icon sits next to the others:

- A 24px frame with a 3px margin: shapes stay between 3 and 21. A circle has a radius of 9, a square is 18 wide, and a narrow shape such as a plug or a key fills the height.
- One 1.5px stroke with round caps and joins. No fills and no other stroke widths.
- Corner radius 2 for a frame (2.5 for the Agent head), 1.5 for a block inside it, and 1 or less for a small mark.
- Coordinates on the half-pixel grid. A dot is a `h.01` path, so it is as wide as the stroke.
- One idea per icon, with as few parts as it needs. Put the one part that can move on hover in `<g data-motion="">`, and set its motion in `@vite-hub/ui/styles.css`.

`vp run build` writes `dist/`. The tests check the frame, the stroke, and the grid.
