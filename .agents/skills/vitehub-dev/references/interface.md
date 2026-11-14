# Build an interface

Read this when a change touches the Console, the docs site, a hero visual, or any other interface. `CONTRIBUTING.md` has the visual rules under "Visual and design work". This file adds the judgment that comes up again and again in review.

## Reuse before you design

- Start from the styles and components that ViteHub already has: the ViteHub theme, `@vite-hub/ui`, and comark-ui. Add no new background, border, card style, or icon family.
- When a pattern is missing, copy a product that does it well (T3 Code, Linear, the Vercel and Cloudflare dashboards, shadcn). Read its current source or screenshots, not your memory of it.
- Use the ViteHub icon set for primitives and Lucide for everything else. Do not mix filled and outline icons.
- Fix a visual bug in the shared component, for every component that has it, not in one page.

## Simple by default

- Design each screen around its main task. Make the main action easy to find and cut chrome that does not serve it.
- Show little by default and put power one click away, such as in a popover or a details panel.
- Keep state in the URL, so a link opens the same view.
- Hide empty UI. A button that has nothing to do is noise.
- Use fewer borders. Separate with spacing, without wasting space.

## No visible glitches

- No layout shift. Reserve space for content that loads.
- Give every view a real loading, empty, and error state.
- Show feedback where the action happens. Update optimistically. Use a toast only for an error that has no better place.

## Prove it

Check the interface in a browser at the widths and themes it affects before you report it. Attach before and after images to the pull request. For motion or timing, attach a short video.
