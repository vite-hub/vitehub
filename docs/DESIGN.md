# ViteHub design direction

ViteHub should feel like practical infrastructure for Vite teams: fast to understand, portable across providers, and built from small server primitives.

## Logo

Use the grounded black hexagon mark as the primary symbol. The shape references the Nimiq hexagon's radical simplicity, but ViteHub owns the surrounding system: a flat bottom edge sitting on a baseline that can extend into route rails, endpoint dots, code blocks, and provider output maps.

The mark should communicate:

- stable server primitives
- provider-agnostic deployment paths
- developer flow without platform lock-in

The current production assets are generated from the SVG source:

- `docs/public/vitehub-mark.svg` for the source mark
- `docs/public/vitehub-logo.svg` for the horizontal source logo
- `docs/public/vitehub-logo.png` for large horizontal usage
- `docs/public/vitehub-logo-dark.png` for large horizontal dark-surface fallback
- `docs/public/vitehub-logo-header.png` for compact header fallback
- `docs/public/vitehub-logo-header-dark.png` for compact dark-surface fallback
- `docs/public/vitehub-mark.png` for standalone mark usage
- `docs/public/favicon.png` for browser tabs
- `docs/public/apple-touch-icon.png` for install/bookmark surfaces
- `docs/public/github-org-avatar.png` for the GitHub organization avatar

Avoid clouds, shields, cubes, honeycombs, generic lightning bolts, decorative logo construction diagrams, and alternate mark systems.

## Color

The public docs use a monochrome system with equal light and dark modes.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#ffffff` | `#09090b` | Page background |
| Raised | `#fafafa` | `#18181b` | Cards, code, and raised controls |
| Line | `#e4e4e7` | `#27272a` | Borders and route rails |
| Text | `#3f3f46` | `#e4e4e7` | Body text |
| Highlighted | `#18181b` | `#fafafa` | Logo, headings, and selected states |
| Muted | `#71717a` | `#a1a1aa` | Secondary text and endpoint dots |

Keep the system black, white, and zinc. Active states can use stronger ink, heavier borders, or route-line placement instead of hue.

## Typography

Use Geist as the preferred family for product and docs UI.

- **Sans:** Geist Sans for navigation, headings, body text, and controls.
- **Mono:** Geist Mono for code, package names, environment variables, and terminal UI.

Use sentence-case headings. Keep headings direct and functional.

## Visual style

The visual system should be quiet, technical, and precise.

- Prefer compact docs layouts over marketing-heavy composition.
- Use sharp alignment, clear spacing, and restrained borders.
- Use grounded route, rail, endpoint, and primitive-block motifs when illustration is needed.
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
