interface ContentTypeSignature {
  segments: Array<[offset: number, bytes: number[]]>
  type: string
}

const signatures: ContentTypeSignature[] = [
  { segments: [[0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]]], type: "image/png" },
  { segments: [[0, [0xFF, 0xD8, 0xFF]]], type: "image/jpeg" },
  { segments: [[0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]]], type: "image/gif" },
  { segments: [[0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]]], type: "image/gif" },
  { segments: [[0, [0x42, 0x4D]]], type: "image/bmp" },
  { segments: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]], type: "image/webp" },
  { segments: [[0, [0x49, 0x49, 0x2A, 0x00]]], type: "image/tiff" },
  { segments: [[0, [0x4D, 0x4D, 0x00, 0x2A]]], type: "image/tiff" },
  { segments: [[0, [0x00, 0x00, 0x01, 0x00]]], type: "image/x-icon" },
  { segments: [[0, [0x25, 0x50, 0x44, 0x46, 0x2D]]], type: "application/pdf" },
]

function matchesAt(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (offset + signature.length > bytes.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

export function detectContentType(bytes: Uint8Array): string | undefined {
  return signatures.find(signature => signature.segments.every(
    ([offset, segment]) => matchesAt(bytes, offset, segment),
  ))?.type
}
