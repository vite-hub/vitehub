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
- `docs/public/og/vitehub.png` for social previews on every docs page
- `.github/assets/readme-banner-light.png` and `.github/assets/readme-banner-dark.png` for the README header

Run `node docs/scripts/og-images.mjs` to render the social preview and the README banners again. The script uses a Chromium executable from `OG_CHROMIUM_PATH`, or a `chromium`/`google-chrome` command on `PATH`; install Chromium or set that variable before running it.

Avoid clouds, shields, cubes, honeycombs, generic lightning bolts, decorative logo construction diagrams, and alternate mark systems.

## Color

The docs share one design with the comark-ui site. It lives in `@vite-hub/docs` (`packages/docs/runtime/theme/design.css`) as neutral grays in OKLCH on the Nuxt UI `--ui-*` variables, with equal light and dark modes. Use the variables, not the hex values.

| Role | Variable | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| Canvas | `--ui-bg` | `#ffffff` | `#0a0a0a` | Page background |
| Raised | `--ui-bg-muted` | `#f7f7f7` | `#131313` | Code, panels, and raised controls |
| Line | `--ui-border` | `#e4e4e4` | `#242424` | Borders and hairlines |
| Text | `--ui-text` | `#404040` | `#d4d4d4` | Body text |
| Highlighted | `--ui-text-highlighted` | `#171717` | `#f2f2f2` | Logo, headings, and selected states |
| Muted | `--ui-text-muted` | `#5d5d5d` | `#9e9e9e` | Secondary text |

Keep the system black, white, and gray, with no hue. Active states use stronger ink or a heavier border instead of a color.

## Icons

Every icon on the site comes from one family: the 24px Lucide grid with a 1.5px stroke, round caps, and round joins.

- A Server Primitive or docs area uses its ViteHub icon, `i-vitehub-<name>` from `packages/icons`, wherever it appears: the rail, the sidebar, the home page grid, the docs catalog, the README, and the Console. If one is missing, draw it in `packages/icons`. Do not borrow a stock icon for a primitive.
- Every other icon is Lucide, `i-lucide-<name>`. `@vite-hub/docs` draws Lucide at 1.5px, the stroke of the ViteHub set.
- Brand logos, `i-simple-icons-<name>`, are only for a real product: a host, a package manager, GitHub, or Discord. The sidebar shows line icons only.
- Do not use Phosphor or another set in the site. The `@vite-hub/ui` examples keep the icons that the components ship with.

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
- Use the ViteHub icon of a primitive to identify it, as the Icons section says.
- Keep provider visuals neutral unless a provider page needs a real provider logo.

Avoid decorative gradients, orbs, mascot art, heavy shadows, and dark cyberpunk styling.

## UI tone

ViteHub UI copy should be concrete and developer-facing.

- Say what the primitive does.
- Prefer examples over abstract claims.
- Keep provider support explicit.
- Make escape hatches and runtime assumptions visible.

The brand should feel confident because the product is understandable, not because the interface is loud.
