export const Readable = {
  toWeb() {
    throw new Error("Vercel Blob cannot convert Node.js streams in this runtime")
  },
}
