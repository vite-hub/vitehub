import type { Collections, CollectionQueryBuilder } from "@nuxt/content";

declare global {
  const queryCollection: <T extends keyof Collections>(collection: T) => CollectionQueryBuilder<Collections[T]>;
}

export {};
