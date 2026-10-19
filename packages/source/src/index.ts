export { array } from "./core/array-collection.ts"
export type {
  ArrayCollectionLoader,
  ArrayCollectionOptions,
  ArrayCollectionQuery,
  ArrayCollectionQueryInput,
  ArrayCollectionSnapshot,
  ArrayCollectionSort,
} from "./core/array-collection.ts"
export { CollectionCursorError, defineCollection } from "./core/collection.ts"
export type {
  AnyCollection,
  AnyCollectionSource,
  Collection,
  CollectionClientItem,
  CollectionCursorErrorOptions,
  CollectionCursorErrorReason,
  CollectionCursorValue,
  CollectionFacets,
  CollectionFacetValue,
  CollectionItem,
  CollectionLoader,
  CollectionLoadOptions,
  CollectionOptions,
  CollectionPage,
  CollectionPageOptions,
  CollectionReadOptions,
  CollectionQueryBuilder,
  CollectionQuery,
  CollectionQueryInput,
  CollectionRequestQuery,
  CollectionSource,
  SourceCollectionOptions,
  CursorCollectionSource,
  ProviderCollectionSource,
  ProviderCollectionPage,
  ProviderCollectionOptions,
  ProviderCollectionLoader,
} from "./core/collection.ts"
export { combineSources } from "./core/combine-sources.ts"
export { defineSource, defineSources } from "./core/define.ts"
export { createSource } from "./core/reader.ts"
export {
  clearSources,
  getRegisteredSource,
  registerSource,
  registerSources,
  useSource,
} from "./core/registry.ts"
export type * from "./core/types.ts"
export type { SourceErrorCode } from "./core/errors.ts"
export { sourceIgnores } from "./ignores.ts"
