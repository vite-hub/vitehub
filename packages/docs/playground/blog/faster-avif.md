---
title: How we made AVIF encoding three times faster
description: Tiles, a shared thread pool, and one benchmark that we stopped trusting.
date: 2026-07-21
authors: [kenji]
tags: [engineering, avif]
---

When Lumen 1.3 added AVIF output, the first bug report was about time, not size: a folder of 500 photos took nine minutes. Lumen 1.3.1 does the same folder in under three. Here is what changed.

## One encoder per core was the wrong unit

The first version ran one AVIF encoder per file, with one encoder per CPU core. That looks parallel, but a large photo keeps one core busy for a long time while the other cores finish small files and wait. The total time was the time of the largest file.

Lumen now splits each image into tiles and sends the tiles to one shared pool. A large photo uses every core, and a small one finishes in one pass. The tiles also fixed the crash on images wider than 8,192 pixels, which hit the encoder's frame limit.

## The benchmark lied

Our benchmark folder had 40 photos of the same size. Real folders do not look like that: they have a few huge hero images and many thumbnails. We replaced it with 500 files copied from three real sites, and the numbers changed by a factor of two. Measure on the folders that your users have.

## Results

| Folder | 1.3.0 | 1.3.1 |
| --- | --- | --- |
| 500 photos, mixed sizes | 9 min 4 s | 2 min 51 s |
| 40 photos, same size | 1 min 12 s | 1 min 5 s |
| One 12,000 px panorama | Failed | 14 s |

All runs are on a 10-core laptop with `quality: 60`. The [AVIF guide](/docs/guides/formats) has the settings that we recommend.
