---
title: Blob media and images
description: Keep alt text, focal points, and crops next to Blob objects, organize them in folders, and serve responsive image variants.
navigation.title: Media and images
navigation.order: 5
icon: i-lucide-image
---

`blob.media` adds media records to every Blob Store. A record holds what an image needs beyond its bytes: dimensions, a content hash, alt text, a caption, a focal point, a placeholder color, and named crops for art direction. The generated serve route turns `?w=640` into a resized variant, and `responsiveImage()` builds the `srcset`, `sizes`, and `<picture>` sources for you.

Records are JSON objects in the same store, so they work on every driver, including Vercel Blob, which rejects custom metadata.

## Store media

`blob.media.put()` stores the object, reads its dimensions from the file header, hashes it, and writes its record.

```ts [server/api/media.post.ts]
import { blob } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  // Authorize the request here. The route decides who may upload.
  const [error, records] = await blob.media.handleUpload(event, {
    folder: 'posts/2026',
    ensure: { maxSize: '16MB', types: ['image'] },
  })
  if (error) throw error
  return records
})
```

`handleUpload()` reads the `files` form field like `blob.handleUpload()`, stores each file under `folder`, and returns one record per file. It deduplicates by default: when the store already holds the same bytes, it returns the existing record and stores nothing. `media.put()` writes to the pathname you give it unless you pass `dedupe: true`.

```ts
const [error, record] = await blob.media.put('posts/cover.jpg', file, {
  alt: 'A field at sunrise',
  focal: { x: 0.7, y: 0.4 },
  crops: { mobile: { aspect: '4:5' } },
})
```

A record looks like this:

```json
{
  "pathname": "posts/cover.jpg",
  "contentType": "image/jpeg",
  "size": 482113,
  "hash": "ab44693b…",
  "etag": "\"ab44693b…\"",
  "width": 2400,
  "height": 1600,
  "color": "#138cdb",
  "alt": "A field at sunrise",
  "focal": { "x": 0.7, "y": 0.4 },
  "crops": { "mobile": { "aspect": "4:5" } },
  "createdAt": "2026-10-14T15:38:53.716Z",
  "updatedAt": "2026-10-14T15:38:53.716Z",
  "url": "/api/_vitehub/blob/posts/cover.jpg"
}
```

- `width` and `height` come from the JPEG, PNG, WebP, GIF, AVIF, or SVG header, after EXIF rotation. Other files have no dimensions. `probeImage()` from `@vite-hub/blob/media` exposes the same parser.
- `color` is the average color, for a placeholder background. It needs an [image transformer](#image-transformers), so passthrough stores leave it out.
- `focal` runs from 0 to 1 on each axis. `{ x: 0.5, y: 0.5 }` is the center.
- `url` is the served URL when the store is the [served store](/docs/blob/configure#serve-blob-backed-assets). It is never stored.

## Read and edit records

`media.get()` returns the record, or `null` when the object does not exist. When an object has no record, or its ETag changed because something overwrote it with `blob.put()`, `get()` reads the object again, keeps the alt text, caption, focal point, and crops, and stores the new record. So objects that you stored without `blob.media` also have records.

```ts
const [error, record] = await blob.media.get('posts/cover.jpg')

await blob.media.update('posts/cover.jpg', {
  alt: 'A field at sunrise',
  caption: null, // null removes a field
  focal: { x: 0.2, y: 0.5 },
  crops: { square: { aspect: '1:1' }, story: null },
})
```

`update()` merges crops by name, and `null` removes one. Changing the focal point or crops clears the cached variants of the object, so the next request crops again.

## Folders

Folders are pathname prefixes. `media.list()` lists one folder level by default and hides ViteHub's `_vitehub/` folders.

```ts
const [, page] = await blob.media.list({ prefix: 'posts/' })
// page.folders: ['posts/2026/'], page.items: MediaRecord[]

await blob.media.createFolder('posts/drafts')
await blob.media.moveFolder('posts/drafts', 'archive/drafts')
await blob.media.removeFolder('archive/drafts')                  // fails with BLOB_CONFLICT when not empty
await blob.media.removeFolder('archive/drafts', { force: true }) // removes every object and its record
```

An empty folder holds an empty `.keep` object, because object stores have no directories. `media.list()` hides it; `blob.list()` shows it.

List items come from the stored records. An item whose object changed since its record was written lists without dimensions or a hash until `media.get()` reads it again. Listing reads one record per object, so keep `limit` at the default of 100 for large folders.

## Move and remove

Object stores have no rename. `media.move()` copies the object, its record, and its crop replacements, then deletes the originals and the cached variants of both pathnames.

```ts
const [error, record] = await blob.media.move('posts/cover.jpg', 'posts/2026/cover.jpg')
// error.code === 'BLOB_CONFLICT' when the destination exists; pass { overwrite: true } to replace it
await blob.media.remove('posts/2026/cover.jpg') // object, record, crops, and variants
```

Content that stores a pathname, such as an `image()` field, keeps pointing at the old pathname after a move. Update those references in the same request.

## Image variants

The generated serve route reads variant parameters from the query string. A request without them serves the original.

```text
/api/_vitehub/blob/posts/cover.jpg?w=640
/api/_vitehub/blob/posts/cover.jpg?w=256&h=256
/api/_vitehub/blob/posts/cover.jpg?w=640&crop=mobile&fmt=avif&q=60
```

| Parameter | Values | Default |
| --- | --- | --- |
| `w` | Width in pixels. | Source width. |
| `h` | Height in pixels. | From the width and aspect. |
| `fit` | `inside` scales to fit the box. `cover` fills it and crops around the focal point. | `cover` when both `w` and `h` are set, otherwise `inside`. |
| `fmt` | `webp`, `avif`, `jpeg`, `png` | `webp` |
| `q` | Quality from 1 to 100. PNG stays lossless. | `blob.images.quality`, 75 |
| `crop` | A crop name of the record. Unknown names serve the uncropped image. | None |

Widths and heights snap up to the nearest allowed size, 16 through 3840 by default, and variants never upscale. `?w=641` and `?w=700` both return the 750-pixel variant, so a client cannot fill the cache with arbitrary sizes. Use a named crop when you need an exact aspect ratio. Invalid values return status 400; other query parameters, such as a cache-busting `?v=`, are ignored.

Variants are cached under `_vitehub/derived/` like every [transformed object](/docs/blob/server-api#serve-a-transformed-object). The ETag covers the source version, the crop region, the output size, the format, and the transformer, so a new focal point produces a new ETag. JPEG, PNG, WebP, and AVIF sources get variants. GIF and SVG sources serve the original, because a variant would drop animation or vector detail.

In your own routes, pass the variant to `blob.serve()`:

```ts
import { blob, parseImageVariant } from '@vite-hub/blob'

const [error, stream] = await blob.serve(event, pathname, {
  variant: parseImageVariant(getQuery(event)) ?? { width: 640 },
})
```

### Image transformers

`blob.images.transformer` picks how variants are made. The default, `auto`, checks per request.

| Host | `auto` uses | Notes |
| --- | --- | --- |
| Node, Docker, Vercel functions | sharp, when the project installs it | The generated Nitro plugin imports sharp, so Nitro bundles or traces it. Run `pnpm add sharp`. |
| Cloudflare Workers | The `IMAGES` binding, when the Worker has it | Set `transformer: 'cloudflare-images'` and ViteHub adds the binding to the generated Worker config. Cloudflare bills transformations. |
| Any host without sharp or the binding | Passthrough | Variant URLs serve the original bytes and type. Dimensions and hashes still work. |

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 'cloudflare-r2',
    serve: true,
    images: { transformer: 'cloudflare-images', sizes: [320, 640, 1280, 1920], quality: 70 },
  },
})
```

An explicit `sharp` fails the build when the project cannot resolve sharp. An explicit `cloudflare-images` fails variant requests with `BLOB_R0034` when the binding is missing. `images: false` always serves originals. To use another image service, pass an object with `name` and `transform(input, operation)` as `images` to `createBlobStorage()`. The operation has the region to cut, the exact output size, the format, and the quality.

Passthrough keeps the `srcset` URLs valid, but every candidate downloads the full original. Install sharp or add the binding before you rely on variants for page weight.

## Art direction

A crop names an aspect ratio, such as a 4:5 image for narrow screens. Without anything else, ViteHub cuts the largest region with that aspect around the crop's focal point, or the record's focal point.

When a generated crop is not good enough, upload a replacement for that crop. ViteHub stores it under `_vitehub/media/crops/` and serves it for `?crop=mobile` at the same URL.

```ts
await blob.media.replaceCrop('posts/cover.jpg', 'mobile', portraitFile) // a new crop takes the file's aspect
await blob.media.replaceCrop('posts/cover.jpg', 'mobile', null)         // back to cropping the original
```

Replacements must be JPEG, PNG, WebP, or AVIF images. They crop from their center when their aspect differs from the crop.

## Responsive images

`responsiveImage()` from `@vite-hub/blob/media` turns a record into `<picture>` sources and `<img>` attributes. It is framework-neutral and safe to import in the browser.

```ts [server/api/posts/[slug].get.ts]
import { blob, responsiveImage } from '@vite-hub/blob'

export default defineEventHandler(async (event) => {
  const post = await findPost(getRouterParam(event, 'slug')!)
  const [error, cover] = await blob.media.get(post.cover)
  if (error) throw error
  return {
    ...post,
    cover: cover && responsiveImage(cover, {
      sizes: '(min-width: 1024px) 768px, 100vw',
      art: [{ media: '(max-width: 640px)', crop: 'mobile' }],
      fetchpriority: 'high',
      loading: 'eager',
    }),
  }
})
```

```vue [components/CoverImage.vue]
<script setup lang="ts">
import type { ResponsiveImage } from '@vite-hub/blob/media'

defineProps<{ image: ResponsiveImage }>()
</script>

<template>
  <picture>
    <source v-for="source in image.sources" :key="source.media" v-bind="source">
    <img v-bind="image.img" style="width: 100%; height: auto; object-fit: cover">
  </picture>
</template>
```

`img` has `src`, `srcset`, `sizes`, `width`, `height`, `alt`, `loading`, `decoding`, and a `style` with `object-position` from the focal point and the placeholder `background-color`. The `srcset` stops at the source width. Each art-direction source has its own `width` and `height`, so the browser reserves the right box on every screen.

Preload the largest image above the fold with unhead:

```ts
useHead({
  link: [{ rel: 'preload', as: 'image', imagesrcset: cover.img.srcset, imagesizes: cover.img.sizes, fetchpriority: 'high' }],
})
```

When you configure custom `blob.images.sizes`, pass the same values as `widths`. The server snaps other widths anyway.

## Media in Content

`image()` and `file()` references store `{ pathname, contentType, size }` and nothing else. Read alt text, dimensions, and crops from the record when you render:

```ts
const [, record] = await blob.media.get(entry.cover) // accepts the reference object
```

References stay portable in Markdown frontmatter and JSON, and an alt-text fix in the media library shows on every page that uses the image. Copying alt text or dimensions into each document would go stale when an editor changes the record. Write alt text into the document only when it differs per use.

## Storage layout

| Pathname | Holds |
| --- | --- |
| `<pathname>` | The object. |
| `_vitehub/media/records/<pathname>.json` | Its record. |
| `_vitehub/media/hashes/<sha256>.json` | The pathname that holds those bytes, for deduplication. |
| `_vitehub/media/crops/<owner>/<crop>.<hash><ext>` | Crop replacements. `<owner>` is a hash of the object pathname. |
| `_vitehub/derived/<hash>/<hash>` | Cached variants, prefixed by a JSON header with the transform key. |
| `<folder>/.keep` | Marker of an empty folder. |

`blob.put()`, signed PUTs, multipart uploads, and `image()` references reject `_vitehub/derived/` and `_vitehub/media/`, and the serve route returns 404 for them.

## Consistency

Media operations make several provider calls: the object, then its record, then the hash entry. Writes are last-writer-wins. Two editors who update one record at the same time can overwrite each other's change. Use one editor per item, or serialize edits in your application.

When a call fails midway:

- An object without a record gets a record on the next `media.get()`.
- A failed `move()` can leave both copies. Run it again with `{ overwrite: true }`, or remove the copy.
- A record or hash entry without its object is ignored: `get()` returns `null`, and deduplication checks that the object still exists.

Eventually consistent providers can briefly list an object before its record. Records are never authoritative for the bytes; ETags are.

## Inspect media

```bash [Terminal]
pnpm vitehub blob media posts/cover.jpg
pnpm vitehub blob variants posts/cover.jpg
pnpm vitehub blob list --prefix _vitehub/media/records/
```

`media` prints the record, building it when missing. `variants` lists each cached variant with its transform key, such as `image:v1;src=crop:mobile;region=1200,0,800x1000;out=640x800;fmt=webp;q=75;engine=sharp`, its type, and its size. Both accept `--store` and `--json`. In code, `blob.media.variants(pathname)` returns the same list.
