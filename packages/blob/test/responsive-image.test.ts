import { describe, expect, it } from "vitest"

import { responsiveImage } from "../src/media/responsive.ts"
import { parseImageVariant, resolveImageGeometry } from "../src/media/variant.ts"

describe("responsive image variant widths", () => {
  it.each([6000, 12000])("advertises the served width of a %s-pixel source", (width) => {
    const source = { height: 4000, width }
    const image = responsiveImage({ ...source, url: "/photo.jpg" })

    for (const candidate of image.img.srcset!.split(", ")) {
      const [url, descriptor] = candidate.split(" ")
      const variant = parseImageVariant(new URL(url!, "https://example.com").searchParams)!
      const output = resolveImageGeometry({ source, variant })
      expect(descriptor).toBe(`${output.width}w`)
    }
    expect(image.img.width).toBe(width)
  })

  it("snaps and deduplicates requested widths with the server's configured sizes", () => {
    const image = responsiveImage({ height: 4000, width: 6000, url: "/photo.jpg" }, {
      imageSizes: [320, 640, 1280],
      widths: [300, 320, 500, 640, 2000],
    })

    expect(image.img.srcset).toBe([320, 640, 1280].map(width => `/photo.jpg?w=${width}&fmt=webp ${width}w`).join(", "))
    expect(image.img.src).toBe("/photo.jpg?w=1280&fmt=webp")
  })

  it("caps named crops and replacement sources while preserving intrinsic dimensions", () => {
    const image = responsiveImage({
      crops: { square: { aspect: "1:1", replacement: { height: 7000, width: 8000 } } },
      height: 4000,
      width: 6000,
      url: "/photo.jpg",
    }, { art: [{ crop: "square", media: "(max-width: 640px)" }] })

    expect(image.sources[0]).toMatchObject({ height: 7000, width: 7000 })
    expect(image.sources[0]!.srcset.split(", ").at(-1)).toBe("/photo.jpg?w=3840&fmt=webp&crop=square 3840w")
  })
})
