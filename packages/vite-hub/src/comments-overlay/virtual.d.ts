declare module "virtual:comments-overlay-icons" {
  /** The shapes of each icon, on a 256 by 256 grid, by Iconify class name such as `i-ph-check`: `[tag, attributes]`. */
  export const icons: Record<string, ReadonlyArray<readonly [string, Record<string, string>]>>
}

declare module "*.css?inline" {
  const css: string
  export default css
}
