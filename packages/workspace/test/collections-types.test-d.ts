import { computed, ref } from "vue"
import { expectTypeOf } from "vitest"

import { getWorkspaceCollectionItem, queryWorkspaceCollection } from "../src/collections.ts"
import { useWorkspaceCollection, useWorkspaceCollectionItem } from "../src/collections/client.ts"

interface Article {
  slug: string
  title: string
}

const collection = useWorkspaceCollection<Article>("/api/articles", {
  immediate: false,
  query: computed(() => ({ search: "guide" })),
})
expectTypeOf(collection.items.value).toEqualTypeOf<Article[]>()
expectTypeOf(collection.loadMore).returns.resolves.toMatchTypeOf<{ items: Article[] } | undefined>()

const item = useWorkspaceCollectionItem<Article>("/api/articles", ref("intro"))
expectTypeOf(item.data.value).toEqualTypeOf<Article | null>()

expectTypeOf(queryWorkspaceCollection<Article>).returns.resolves.toMatchTypeOf<{ items: Article[] }>()
expectTypeOf(getWorkspaceCollectionItem<Article>).returns.resolves.toMatchTypeOf<{ item: Article | null }>()
