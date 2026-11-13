# ViteHub design system

ViteHub looks like the Vercel dashboard and shadcn/ui: Geist, black and white with neutral grays, hairline borders, 6px controls, and one blue that only marks focus. The Console, vitehub.dev, `@vite-hub/docs` sites such as comark-ui, and the playgrounds all use the same theme, so a component looks and behaves the same everywhere.

## Where it lives

- `packages/ui/theme.css` (`@vite-hub/ui/theme.css`): tokens, fonts, status text colors, and the one focus rule.
- `packages/ui/theme-focus-ring.css`: wrapper focus frames, including the row comment field, shared by `theme.css` and `styles.css` so the documented package installation keeps them.
- `packages/ui/src/theme.ts` (`@vite-hub/ui/theme`): `vitehubTheme`, the Nuxt UI app config. It sets the default variant, size, radius, and surface of each component.
- A surface imports both and adds slots only for parts that no other surface has, such as the Console's `dashboardNavbar` or the docs shell. It never restyles a component that the theme already styles.

```css
@import "tailwindcss";
@import "@nuxt/ui";
@import "@vite-hub/ui/theme.css";
```

```ts
import { vitehubTheme } from "@vite-hub/ui/theme"
export default defineAppConfig({ ui: { ...vitehubTheme, dashboardNavbar: { /* Console only */ } } })
```

## Rules that apply everywhere

1. **Never style focus.** The theme draws one 2px blue ring (`--vh-focus`) on whatever has keyboard focus, and turns a text field's own frame blue (red when the field has an error). A writing surface without a frame, such as the command palette input or the document editor, shows focus with its caret. Rows in a clipped list get the ring inside; a link row opts in with `data-focus-inset`. Do not add `focus-visible:outline-*`, `focus-visible:ring-*`, `has-focus-visible:*`, or a `:focus` CSS rule. A component that needs a different focus shape is a theme change, not a component change. Why: every hand-made ring we had was a different color, offset, or width, and pages showed five focus styles at once.
2. **Never write a color.** Use the Nuxt UI tokens through their utilities (`text-muted`, `bg-elevated`, `border-default`) or `var(--ui-*)` and `var(--vh-*)` in CSS. No hex, `rgb()`, `oklch()`, or palette classes such as `text-zinc-500` or `bg-sky-600`. Brand logos are the only exception, and they live in one registry.
3. **Use a Nuxt UI component before you build one.** `UTabs` for every tab strip, `UButton` for every button, `UBadge` for every pill, `UEmpty` for every empty state. A `<button>` styled by hand, or a `role="tab"` element, is a bug.
4. **Use the defaults.** The theme already picks the variant and the size. Pass `variant`, `size`, or `color` only when the component docs below say to. Do not pass `:ui` to restyle a slot.
5. **Keep weight still.** Selected and hover states change color, never font weight, so nothing moves.

`test/design-rules.test.ts` fails on a focus class, a focus CSS rule, a color literal, or a hand-made tab strip in any surface. Run it with `vp test run test/design-rules.test.ts`.

## Read when needed

- [Tokens](design/tokens.md): which background, text, border, radius, and shadow to use.
- [Components](design/components.md): which component and which variant for each job.
- [Brand](design/brand.md): the logo, its assets, and the tone of UI copy.
