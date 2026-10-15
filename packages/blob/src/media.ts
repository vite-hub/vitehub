// Browser-safe media helpers. Server media APIs live on `blob.media` from `@vite-hub/blob`.
export { probeImage } from "./media/probe.ts"
export type { ImageProbe, ImageProbeFormat } from "./media/probe.ts"
export { responsiveImage } from "./media/responsive.ts"
export type {
  ResponsiveImage,
  ResponsiveImageArtDirection,
  ResponsiveImageAttributes,
  ResponsiveImageInput,
  ResponsiveImageOptions,
  ResponsiveImageSource,
} from "./media/responsive.ts"
export {
  defaultImageQuality,
  defaultImageSizes,
  defaultResponsiveWidths,
  focalCropRegion,
  focalPointToObjectPosition,
  imageVariantUrl,
  isMediaCropName,
  parseAspectRatio,
  parseImageVariant,
  resolveImageGeometry,
  snapImageSize,
} from "./media/variant.ts"
export type { ImageGeometryInput } from "./media/variant.ts"
export type {
  BlobImageFit,
  BlobImageFormat,
  BlobImageOperation,
  BlobImagesOptions,
  BlobImageTransformer,
  BlobImageTransformerName,
  BlobImageVariant,
  MediaCrop,
  MediaCropReplacement,
  MediaFocalPoint,
  MediaRecord,
  MediaUpdate,
  MediaVariantEntry,
} from "./media/types.ts"
