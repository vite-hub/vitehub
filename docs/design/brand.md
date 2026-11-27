# Brand

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

## UI tone

ViteHub UI copy should be concrete and developer-facing.

- Say what the primitive does.
- Prefer examples over abstract claims.
- Keep provider support explicit.
- Make escape hatches and runtime assumptions visible.

The brand should feel confident because the product is understandable, not because the interface is loud.
