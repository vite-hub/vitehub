// Check the fields that callers read, so Blob and File values from another realm also match.
export default function isBlob(value: unknown): value is Blob {
  return typeof value === "object" && value !== null
    && "type" in value && typeof value.type === "string"
    && "size" in value && typeof value.size === "number"
    && "arrayBuffer" in value && typeof value.arrayBuffer === "function"
}
