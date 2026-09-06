const dependencies = Object.freeze([
  "**/node_modules/**",
  "**/.pnpm-store/**",
  "**/.venv/**",
  "**/dbt_packages/**",
] as const)

const generated = Object.freeze([
  "**/.nuxt/**",
  "**/.output/**",
  "**/coverage/**",
  "**/playwright-report/**",
  "**/target/**",
  "**/test-results/**",
] as const)

const media = Object.freeze(["**/*.{gif,ico,jpeg,jpg,png,webp}"] as const)
const secrets = Object.freeze(["**/.env", "**/.env.*"] as const)
const system = Object.freeze([
  "**/.DS_Store",
  "**/__pycache__/**",
  "**/*.pyc",
] as const)

export const sourceIgnores: Readonly<{
  defaults: readonly string[]
  dependencies: readonly string[]
  generated: readonly string[]
  media: readonly string[]
  secrets: readonly string[]
  system: readonly string[]
}> = Object.freeze({
  defaults: Object.freeze([
    ...dependencies,
    ...generated,
    ...media,
    ...secrets,
    ...system,
  ] as const),
  dependencies,
  generated,
  media,
  secrets,
  system,
})
