// `@nuxt/icon` declares this hook, but the program only sees that declaration through `@nuxt/ui`'s types, and only
// when that `@nuxt/icon` copy uses the `@nuxt/schema` of `@nuxt/kit`. Declare the hook that `nuxt.ts` uses here.
declare module "@nuxt/schema" {
  interface NuxtHooks {
    "icon:clientBundleIcons"(icons: Set<string>): void;
  }
}

export {};
