/**
 * Brand colors of the frameworks and hosts whose logos the site shows. Logos are the only place where the docs use a
 * color outside the theme tokens, so every brand color lives here. A brand whose mark is black or white, such as
 * Vercel or Deno, has no entry and takes the text color.
 */
export const brandColors = {
  cloudflare: "#f48120",
  docker: "#2496ed",
  netlify: "#00c7b7",
  nitro: "#f27cec",
  node: "#5fa04e",
  nuxt: "#00dc82",
  tanstack: "#ef4444",
  vite: "#646cff",
} as const;

export type BrandColorKey = keyof typeof brandColors;
