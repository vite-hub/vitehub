---
title: Blob media and images
description: Keep alt text, focal points, and crops next to Blob files, sort them in folders, and serve responsive image variants.
navigation.title: Media and images
navigation.order: 8
icon: i-lucide-image
---

`blob.media` adds a media record to each file in a Blob Store. A record holds dimensions, a content hash, alt text, a caption, a focal point, a placeholder color, and named crops. The serve route turns `?w=640` into a resized variant. `responsiveImage()` builds the `srcset`, `sizes`, and `<picture>` sources.

Records are JSON files in the same store, so they work on every driver, even Vercel Blob, which rejects custom metadata.

## Store media

`blob.media.put()` stores the file, reads its dimensions from the header, hashes it, and writes its record.

```ts [server/api/media.post.ts]
import { defineEventHandler } from 'h3'
import { blob } from 'vite-hub/blob'

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

`handleUpload()` reads the `files` form field, stores each file under `folder`, and returns one record per file. If the store already has the same bytes, it returns that record and stores nothing. `media.put()` writes to your pathname unless you pass `dedupe: true`.

```ts [server/utils/cover.ts]
import { blob } from 'vite-hub/blob'

// Store a cover image that server code already holds, such as a generated one
export async function saveCover(file: Blob) {
  const [error, record] = await blob.media.put('posts/cover.jpg', file, {
    alt: 'A field at sunrise',
    focal: { x: 0.7, y: 0.4 },
    crops: { mobile: { aspect: '4:5' } },
  })
  if (error) throw error
  return record
}
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

- `width` and `height` come from the JPEG, PNG, WebP, GIF, AVIF, or SVG header, after EXIF rotation. Other files have none. `probeImage()` from `vite-hub/blob/media` is the same parser.
- `color` is the average color, for a placeholder background. It needs an [image transformer](#image-transformers), so passthrough stores leave it out.
- `focal` runs from 0 to 1 on each axis. `{ x: 0.5, y: 0.5 }` is the center.
- `url` is set only for the [served store](/docs/blob/configure#serve-blob-backed-assets), and is never stored.

## Read and edit records

`media.get()` returns the record, or `null` when the file does not exist. When a file has no record, or `blob.put()` changed its ETag, `get()` rebuilds the record and keeps the alt text, caption, focal point, and crops. So files stored without `blob.media` get records too.

```ts
import { blob } from 'vite-hub/blob'

const [error, record] = await blob.media.get('posts/cover.jpg')

const [updateError, updated] = await blob.media.update('posts/cover.jpg', {
  alt: 'A field at sunrise',
  caption: null, // null removes a field
  focal: { x: 0.2, y: 0.5 },
  crops: { square: { aspect: '1:1' }, story: null },
})
if (updateError) throw updateError
```

`update()` merges crops by name, and `null` removes one. A new focal point or crop clears the cached variants, so the next request crops again.

## Folders

Folders are pathname prefixes. `media.list()` lists one level by default and hides the `_vitehub/` folders.

```ts
import { blob } from 'vite-hub/blob'

const [, page] = await blob.media.list({ prefix: 'posts/' })
// page.folders: ['posts/2026/'], page.items: MediaRecord[]

const [createError] = await blob.media.createFolder('posts/drafts')
const [moveError, moved] = await blob.media.moveFolder('posts/drafts', 'archive/drafts')
const [removeError] = await blob.media.removeFolder('archive/drafts')                       // BLOB_CONFLICT when not empty
const [forceError, removed] = await blob.media.removeFolder('archive/drafts', { force: true }) // removes every object and its record
```

Object stores have no real folders, so an empty folder holds an empty `.keep` file. `media.list()` hides it. `blob.list()` shows it.

List items come from the records. A file that changed after its record lists without dimensions or a hash until `media.get()` reads it again. Listing reads one record per file, so keep `limit` at the default of 100 for large folders.

## Move and remove

Object stores have no rename. `media.move()` copies the file, its record, and its crop replacements. Then it deletes the originals and the cached variants of both pathnames.

```ts
import { blob } from 'vite-hub/blob'

const [error, record] = await blob.media.move('posts/cover.jpg', 'posts/2026/cover.jpg')
// error.code === 'BLOB_CONFLICT' when the destination exists; pass { overwrite: true } to replace it
const [removeError] = await blob.media.remove('posts/2026/cover.jpg') // object, record, crops, and variants
```

An `image()` field or other stored pathname still points at the old path after a move. Update it in the same request.

## Image variants

The serve route reads variant parameters from the query string. Without them, it serves the original.

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

Sizes snap up to the nearest allowed size, 16 through 3840 by default, and never upscale. `?w=641` and `?w=700` both return the 750-pixel variant, so a client cannot fill the cache with random sizes. For an exact aspect ratio, use a named crop. Invalid values return 400. Other parameters, such as a cache-busting `?v=`, are ignored.

Variants are cached under `_vitehub/derived/` like every [transformed object](/docs/blob/server-api#serve-a-transformed-object). The ETag covers the source version, crop region, output size, format, and transformer, so a new focal point gives a new ETag. JPEG, PNG, WebP, and AVIF sources get variants. GIF and SVG serve the original, to keep animation and vector detail.

In your own routes, pass the variant to `blob.serve()`:

```ts fragment
import { blob, parseImageVariant } from 'vite-hub/blob'

const url = new URL(request.url)
return blob.serve(request, pathname, {
  variant: parseImageVariant(url.searchParams) ?? { width: 640 },
})
```

### Image transformers

`blob.images.transformer` picks how variants are made. The default, `auto`, checks on each request.

| Host | `auto` uses | Notes |
| --- | --- | --- |
| Node, Docker, Vercel functions | sharp, when it is installed | The Nitro plugin imports sharp, so Nitro bundles or traces it. Run `pnpm add sharp`. |
| Cloudflare Workers | The `IMAGES` binding, when the Worker has it | With `transformer: 'cloudflare-images'`, ViteHub adds the binding to the Worker config. Cloudflare bills transformations. |
| Any host without sharp or the binding | Passthrough | Variant URLs serve the original file. Dimensions and hashes still work. |

Set `transformer: 'photon'` to make variants with WebAssembly on Workers and Node. See [Photon](#photon-on-workers-and-node).

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      driver: 'cloudflare-r2',
      serve: { access: 'public' },
      images: { transformer: 'cloudflare-images', sizes: [320, 640, 1280, 1920], quality: 70 },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        serve: { access: 'public' },
        images: { transformer: 'cloudflare-images', sizes: [320, 640, 1280, 1920], quality: 70 },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        serve: { access: 'public' },
        images: { transformer: 'cloudflare-images', sizes: [320, 640, 1280, 1920], quality: 70 },
      },
    }),
  ],
})
```
:::
::

- `sharp` fails the build when sharp is not installed.
- `cloudflare-images` fails variant requests with `BLOB_R0034` when the binding is missing.
- `images: false` always serves originals.

For another image service, pass `{ name, transform(input, operation) }` as `images` to `createBlobStorage()`. The operation has the region to cut, the output size, the format, and the quality.

> [!WARNING]
> With passthrough, `srcset` URLs still work, but each one downloads the full original. To make pages lighter, install sharp, add the binding, or use Photon.

### Photon on Workers and Node

The `photon` transformer uses [`@cf-wasm/photon`](https://github.com/fineshopdesign/cf-wasm/tree/main/packages/photon), a Rust image library compiled to WebAssembly. It runs on Node, and on Cloudflare Workers without a paid binding. Install it and select it:

```sh
pnpm add @cf-wasm/photon
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    blob: {
      driver: 'cloudflare-r2',
      serve: { access: 'public' },
      images: { transformer: 'photon' },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        serve: { access: 'public' },
        images: { transformer: 'photon' },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        driver: 'cloudflare-r2',
        serve: { access: 'public' },
        images: { transformer: 'photon' },
      },
    }),
  ],
})
```
:::
::

Photon reads JPEG, PNG, WebP, and GIF. It turns JPEG images upright from their EXIF orientation, cuts the region, and resizes. It writes only pixels, so EXIF, GPS, and other source metadata stay out of the variant. Each step frees the previous image from WebAssembly memory.

| Output | Result |
| --- | --- |
| `fmt=jpeg` | JPEG at the requested quality. Use it for photos. |
| `fmt=png` | PNG without loss. |
| `fmt=webp` | WebP without loss. `q` does nothing, and a photo is often several times larger than its JPEG. |
| `fmt=avif` | Fails with `BLOB_R0036`. Photon cannot write AVIF. |

`responsiveImage()` requests WebP unless you pass `format`, so pass `format: 'jpeg'` for photos.

Photon decodes the full source first, at about 19 bytes of WebAssembly memory per pixel. A Worker has 128 MB in total, so Photon rejects a source over 10 MiB or 4 megapixels (such as 2400 × 1600) with `BLOB_R0036`. A 12-megapixel phone photo is too large: resize it before upload, or use the Cloudflare Images binding. A 4-megapixel JPEG takes about 0.2 seconds of CPU per variant, above the 10 ms Workers Free limit. Variants are cached after the first request.

The Nitro plugin registers `import('@cf-wasm/photon')`, so the WebAssembly module loads on the first variant, not at startup. You configure nothing:

- On Cloudflare, Nitro writes `photon_rs_bg.wasm` as a separate module, so Workers compile it at upload. It adds about 1.5 MB to the Worker before compression.
- On Node, the `node` entry embeds the WebAssembly in JavaScript and compiles it on the first variant.
- In `vite dev` with Cloudflare emulation, workerd blocks WebAssembly compiled at runtime, so variants fail with `BLOB_R0034`. Use a Node host in development, or run the built Worker with `wrangler dev`.

`auto` never selects Photon, even when it is installed. Photon adds 1.5 MB to the Worker, rejects large photos that passthrough serves, and changes the engine in every variant cache key. An explicit `photon` fails the build with `BLOB_B0007` when `@cf-wasm/photon` is not installed.

## Art direction

A crop names an aspect ratio, such as 4:5 for narrow screens. ViteHub cuts the largest region with that aspect around the crop's focal point, or the record's focal point.

When a generated crop is not good enough, upload a replacement. ViteHub stores it under `_vitehub/media/crops/` and serves it for `?crop=mobile` at the same URL.

```ts fragment
const [replaceError] = await blob.media.replaceCrop('posts/cover.jpg', 'mobile', portraitFile) // a new crop takes the file's aspect
const [resetError] = await blob.media.replaceCrop('posts/cover.jpg', 'mobile', null)         // back to cropping the original
```

Replacements must be JPEG, PNG, WebP, or AVIF images. They crop from their center when their aspect differs from the crop.

## Responsive images

`responsiveImage()` from `vite-hub/blob/media` turns a record into `<picture>` sources and `<img>` attributes. It works with any framework and in the browser.

```ts [server/api/posts/[slug].get.ts] fragment
import { blob, responsiveImage } from 'vite-hub/blob'

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
import type { ResponsiveImage } from 'vite-hub/blob/media'

defineProps<{ image: ResponsiveImage }>()
</script>

<template>
  <picture>
    <source v-for="source in image.sources" :key="source.media" v-bind="source">
    <img v-bind="image.img" style="width: 100%; height: auto; object-fit: cover">
  </picture>
</template>
```

`img` has `src`, `srcset`, `sizes`, `width`, `height`, `alt`, `loading`, `decoding`, and a `style` with the focal point as `object-position` and the placeholder `background-color`. The `srcset` stops at the source width. Each art-direction source has its own `width` and `height`, so the browser saves the right space on every screen.

Preload the largest image above the fold with unhead:

```ts fragment
useHead({
  link: [{ rel: 'preload', as: 'image', imagesrcset: cover.img.srcset, imagesizes: cover.img.sizes, fetchpriority: 'high' }],
})
```

With custom `blob.images.sizes`, pass the same values as `widths`. The server snaps other widths anyway.

## Media in Content

`image()` and `file()` references store `{ pathname, contentType, size }` and nothing else. Read alt text, dimensions, and crops from the record when you render:

```ts fragment
const [, record] = await blob.media.get(entry.cover) // accepts the reference object
```

References stay portable in Markdown frontmatter and JSON. An alt-text fix in the [Console media library](/docs/content/console#media-library) shows on every page that uses the image, while copied alt text goes stale. Write alt text into the document only when it differs per use.

The media library edits folders, uploads, alt text, focal points, and crops, and has a picker for `image()` fields and Markdown images.

When another store holds private files, such as the Content workspace, keep media in its own store. Serve it and point `image({ store })` at it. Then `console.authorize` can grant `'blob:media'` for that store alone, so editors and their MCP agents cannot read or change the private store. See [Grant one Blob store](/docs/development/console#grant-one-blob-store).

## Storage layout

| Pathname | Holds |
| --- | --- |
| `<pathname>` | The file. |
| `_vitehub/media/records/<pathname>.json` | Its record. |
| `_vitehub/media/hashes/<sha256>.json` | The pathname with those bytes, for deduplication. |
| `_vitehub/media/crops/<owner>/<crop>.<hash><ext>` | Crop replacements. `<owner>` is a hash of the file pathname. |
| `_vitehub/derived/<hash>/<hash>` | Cached variants, after a JSON header with the transform key. |
| `<folder>/.keep` | Marks an empty folder. |

`blob.put()`, signed PUTs, multipart uploads, and `image()` references reject `_vitehub/derived/` and `_vitehub/media/`. The serve route returns 404 for them.

## Consistency

Each media operation writes the file, then its record, then the hash entry. The last write wins, so two editors on one record at the same time can lose a change. Use one editor per item, or run edits one at a time.

When a call fails midway:

- A file without a record gets one on the next `media.get()`.
- A failed `move()` can leave both copies. Run it again with `{ overwrite: true }`, or remove the copy.
- A record or hash entry without its file is ignored. `get()` returns `null`, and deduplication checks that the file still exists.

Eventually consistent providers can briefly list a file before its record. ETags, not records, are the truth for the bytes.

## Inspect media

```bash [Terminal]
pnpm vitehub blob media posts/cover.jpg
pnpm vitehub blob variants posts/cover.jpg
pnpm vitehub blob list --prefix _vitehub/media/records/
```

`media` prints the record and builds it when missing. `variants` lists each cached variant with its transform key, such as `image:v1;src=crop:mobile;region=1200,0,800x1000;out=640x800;fmt=webp;q=75;engine=sharp`, its type, and its size. Both accept `--store` and `--json`. In code, `blob.media.variants(pathname)` returns the same list.
