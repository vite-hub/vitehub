declare module "vite" {
  export interface Plugin {
    name: string
    [key: string]: unknown
  }

  export interface UserConfig {}
}
