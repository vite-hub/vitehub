# ViteHub design direction

ViteHub should feel like practical infrastructure for Vite teams: fast to understand, portable across providers, and built from small server primitives.

## Logo

Use the runtime switchboard mark as the primary symbol. It is a vertical terminal rail with branching routes to provider endpoints.

The mark should communicate:

- provider-agnostic deployment paths
- server primitives that compose cleanly
- developer flow without platform lock-in

The current production assets are generated raster PNG files:

- `docs/public/vitehub-logo.png` for the light website header
- `docs/public/vitehub-logo-dark.png` for the dark website header
- `docs/public/vitehub-mark.png` for standalone mark usage
- `docs/public/favicon.png` for browser tabs
- `docs/public/apple-touch-icon.png` for install/bookmark surfaces
- `docs/public/github-org-avatar.png` for the GitHub organization avatar

Do not use the old hexagon motif. Avoid clouds, shields, cubes, honeycombs, generic lightning bolts, and hand-built SVG approximations of the generated mark.

## Color

Yellow stays the primary brand color.

| Token | Value | Use |
| --- | --- | --- |
| Yellow | `#facc15` | Logo rail, primary accents, selected states |
| Ink | `#1c1917` | Logo background, headings, high-contrast surfaces |
| Paper | `#fafaf9` | Light backgrounds and logo endpoint dots |
| Stone | `#78716c` | Secondary text, borders, quiet UI |
| Amber | `#f59e0b` | Warnings and secondary emphasis |
| Green | `#22c55e` | Success and provider status only |

Keep yellow crisp and intentional. Most interfaces should be stone, paper, and ink with yellow reserved for identity and active affordances.

## Typography

Use Geist as the preferred family for product and docs UI.

- **Sans:** Geist Sans for navigation, headings, body text, and controls.
- **Mono:** Geist Mono for code, package names, environment variables, and terminal UI.

Use sentence-case headings. Keep headings direct and functional.

## Visual style

The visual system should be quiet, technical, and precise.

- Prefer compact docs layouts over marketing-heavy composition.
- Use sharp alignment, clear spacing, and restrained borders.
- Use small route, rail, endpoint, and primitive-block motifs when illustration is needed.
- Use icons to identify primitives such as Blob, KV, Queue, Workflow, Sandbox, Chat, and Workspace.
- Keep provider visuals neutral unless a provider page needs a real provider logo.

Avoid decorative gradients, orbs, mascot art, heavy shadows, and dark cyberpunk styling.

## UI tone

ViteHub UI copy should be concrete and developer-facing.

- Say what the primitive does.
- Prefer examples over abstract claims.
- Keep provider support explicit.
- Make escape hatches and runtime assumptions visible.

The brand should feel confident because the product is understandable, not because the interface is loud.
