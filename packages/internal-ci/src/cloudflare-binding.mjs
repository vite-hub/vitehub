export function queueBindingName(queue) {
  const encoded = Buffer.from(queue).toString("hex").toUpperCase()
  return encoded ? `QUEUE_${encoded}` : "QUEUE"
}

export function pushUnique(array, item, getKey) {
  const key = getKey(item)
  if (!array.some(entry => getKey(entry) === key))
    array.push(item)
}
