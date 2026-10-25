declare module "virtual:comments-overlay-icons" {
  /** The inner SVG of each icon, on a 256 by 256 grid, by Iconify class name such as `i-ph-check`. */
  export const icons: Record<string, string>
}

declare module "*.css?inline" {
  const css: string
  export default css
}
