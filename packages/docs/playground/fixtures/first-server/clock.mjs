export default function clock() {
  return `It is ${new Date().toISOString().slice(11, 19)} UTC.`
}
