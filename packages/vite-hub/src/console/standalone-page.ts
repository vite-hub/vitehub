// The look of the Console pages that the server writes without the app: sign-in, agent consent, and access denied.
// They use the Console's neutral tokens, so a person who signs in sees the Console, not a plain document.

/** The ViteHub mark, as the Console rail shows it. */
export const consoleMarkSvg = '<svg viewBox="0 0 20 18" aria-hidden="true"><path fill="currentColor" d="M19.734 8.156 15.576.844A1.66 1.66 0 0 0 14.135 0H5.819C5.226 0 4.677.32 4.38.844L.222 8.156a1.71 1.71 0 0 0 0 1.688l4.158 7.312c.297.523.846.844 1.439.844h8.316c.593 0 1.142-.32 1.438-.844l4.158-7.312c.3-.523.3-1.165.003-1.688Z"/></svg>'

/** The header of every standalone page: the mark, then the site and "ViteHub Console". `escapedSite` is HTML-escaped text. */
export function consoleStandaloneHeader(escapedSite: string): string {
  return `<header class="brand"><span class="mark">${consoleMarkSvg}</span><span class="brand-text"><span class="site">${escapedSite}</span><span class="product">ViteHub Console</span></span></header>`
}

/**
 * The theme colors of the browser chrome (`<meta name="theme-color">`): the page color of `@vite-hub/ui/theme.css`.
 * A meta tag cannot read a CSS variable, so the values live here, next to the token block below.
 */
export const consoleThemeColors = { light: "#ffffff", dark: "#0a0a0a" } as const

/**
 * Colors of the page tool, which draws on the developer's own page, where no theme token exists: amber 500 marks the
 * draft, as a warning dot does in the Console, and the focus blue of theme.css outlines the field that the picker targets.
 */
export const consolePageToolColors = { draft: "oklch(0.769 0.188 70.08)", picker: "oklch(0.588 0.158 241.966)" } as const

/**
 * Styles of the standalone pages. The page CSP must allow `style-src 'unsafe-inline'`.
 *
 * These pages have no Tailwind and no Nuxt UI, and the server bundle cannot read `@vite-hub/ui/theme.css`, so this is
 * the one copy of the theme tokens that the server writes. The names and values match theme.css, and
 * `test/console-standalone-page.test.ts` fails when they drift. The focus rule is the theme's: one 2px blue ring, and a
 * text field turns its own frame blue.
 */
export const consoleStandaloneStyles = `
      :root {
        color-scheme: light dark;
        --ui-bg: light-dark(oklch(1 0 0), oklch(0.145 0 0));
        --ui-bg-muted: light-dark(oklch(0.985 0 0), oklch(0.178 0 0));
        --ui-bg-elevated: light-dark(oklch(0.97 0 0), rgb(255 255 255 / 5%));
        --ui-border: light-dark(oklch(0.922 0 0), rgb(255 255 255 / 10%));
        --ui-border-accented: light-dark(oklch(0.87 0 0), rgb(255 255 255 / 16%));
        --ui-text: light-dark(oklch(0.371 0 0), oklch(0.87 0 0));
        --ui-text-muted: light-dark(oklch(0.5 0 0), oklch(0.708 0 0));
        --ui-text-highlighted: light-dark(oklch(0.205 0 0), oklch(0.985 0 0));
        --ui-text-inverted: light-dark(oklch(1 0 0), oklch(0.145 0 0));
        --ui-primary: light-dark(oklch(0.205 0 0), oklch(0.985 0 0));
        --vh-focus: light-dark(oklch(0.588 0.158 241.966), oklch(0.746 0.16 232.661));
        /* theme.css reads these from the Nuxt UI palette: red 700 / 400 and amber 800 / 400. */
        --vh-text-error: light-dark(oklch(0.505 0.213 27.518), oklch(0.704 0.191 22.216));
        --vh-text-warning: light-dark(oklch(0.473 0.137 46.201), oklch(0.828 0.189 84.429));
        font-family: "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      :focus-visible { outline: 2px solid var(--vh-focus); outline-offset: 2px; }
      input:focus-visible { outline: none; border-color: var(--vh-focus); box-shadow: inset 0 0 0 1px var(--vh-focus); }
      ::selection { background: color-mix(in oklab, var(--vh-focus) 24%, transparent); }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 1.5rem; background: var(--ui-bg-muted); color: var(--ui-text); font-size: .875rem; line-height: 1.25rem; }
      main { width: min(100%, 25rem); padding: 1.5rem; border: 1px solid var(--ui-border); border-radius: .5rem; background: var(--ui-bg); }
      .brand { display: flex; align-items: center; gap: .75rem; margin: 0 0 1.5rem; }
      .mark { display: grid; place-items: center; flex: none; width: 2.5rem; height: 2.5rem; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-highlighted); }
      .mark svg { width: 1.125rem; height: 1.125rem; }
      .brand-text { display: grid; min-width: 0; }
      .site { overflow: hidden; color: var(--ui-text-highlighted); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .product { color: var(--ui-text-muted); font-size: .8125rem; }
      h1 { margin: 0; color: var(--ui-text-highlighted); font-size: 1rem; font-weight: 600; line-height: 1.5rem; text-wrap: balance; }
      h1 + p { margin: .25rem 0 0; color: var(--ui-text-muted); text-wrap: pretty; overflow-wrap: anywhere; }
      p { margin: 0; }
      .stack { display: grid; gap: 1rem; margin-top: 1.25rem; }
      .stack:empty { display: none; }
      form { display: grid; gap: .75rem; margin: 0; }
      form[hidden], [hidden] { display: none !important; }
      label { display: grid; gap: .375rem; color: var(--ui-text-highlighted); font-size: .8125rem; font-weight: 500; }
      input { width: 100%; height: 2.25rem; padding: 0 .75rem; border: 1px solid var(--ui-border-accented); border-radius: .375rem; background: var(--ui-bg); color: var(--ui-text-highlighted); font: inherit; font-size: .875rem; }
      @media (pointer: coarse) { input { font-size: 1rem; } }
      .actions { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: .5rem; }
      .actions.column { grid-auto-flow: row; }
      a.button, button { display: inline-flex; align-items: center; justify-content: center; gap: .5rem; height: 2.25rem; padding: 0 .875rem; border: 0; border-radius: .375rem; background: var(--ui-primary); color: var(--ui-text-inverted); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; transition: opacity 150ms ease-out, transform 150ms ease-out; }
      a.button:active, button:not(:disabled):active { transform: scale(.97); }
      a.button.secondary, button.secondary { background: transparent; color: var(--ui-text-highlighted); box-shadow: inset 0 0 0 1px var(--ui-border-accented); }
      @media (hover: hover) { a.button:hover, button:hover { opacity: .88; } a.button.secondary:hover, button.secondary:hover { opacity: 1; background: var(--ui-bg-elevated); } }
      button:disabled { opacity: .5; cursor: wait; }
      .link { height: auto; padding: 0; background: none; color: var(--ui-text-muted); font-size: .8125rem; font-weight: 400; text-decoration: underline; text-underline-offset: 3px; }
      @media (hover: hover) { .link:hover { color: var(--ui-text-highlighted); opacity: 1; } }
      /* Touch screens: 44px targets. A text link grows its tap area only. */
      @media (pointer: coarse) { a.button, button:not(.link), input { height: auto; min-height: 2.75rem; } .link { position: relative; } .link::after { content: ""; position: absolute; inset: -.75rem -.5rem; } }
      .panel { border: 1px solid var(--ui-border); border-radius: .375rem; }
      .row { display: flex; align-items: center; gap: .75rem; padding: .625rem .75rem; min-width: 0; }
      .row + .row { border-top: 1px solid var(--ui-border); }
      .row svg { flex: none; width: 1rem; height: 1rem; color: var(--ui-text-muted); }
      .avatar { display: grid; place-items: center; flex: none; width: 2rem; height: 2rem; border-radius: 999px; background: var(--ui-bg-elevated); box-shadow: inset 0 0 0 1px var(--ui-border); color: var(--ui-text-highlighted); font-size: .75rem; font-weight: 600; }
      .who { display: grid; flex: 1; min-width: 0; }
      .who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .who span:first-child { color: var(--ui-text-highlighted); font-weight: 500; }
      .who span + span { color: var(--ui-text-muted); font-size: .8125rem; }
      .note { color: var(--ui-text-muted); font-size: .8125rem; text-wrap: pretty; overflow-wrap: anywhere; }
      code { font-family: "Geist Mono Variable", ui-monospace, "SF Mono", Menlo, monospace; font-size: .8125rem; color: var(--ui-text-highlighted); }
      [role=alert] { color: var(--vh-text-error); }
      @media (prefers-reduced-motion: reduce) { a.button, button { transition: none; } a.button:active, button:active { transform: none; } }
      @media (max-width: 30rem) { body { place-items: start center; background: var(--ui-bg); padding: 1rem; } main { border: 0; padding: 0; } }
`
