export default function throttle<TThis, TArgs extends unknown[]>(
  callback: (this: TThis, ...args: TArgs) => void,
  wait: number,
) {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JavaScript callers can violate the declared callback type, and throttleit validates this public boundary.
  if (typeof callback !== "function") {
    throw new TypeError(`Expected the first argument to be a \`function\`, got \`${typeof callback}\`.`)
  }

  let lastCallTime = 0
  let timeout: ReturnType<typeof setTimeout> | undefined

  return function throttled(this: TThis, ...args: TArgs) {
    clearTimeout(timeout)
    const delay = wait - (Date.now() - lastCallTime)
    if (delay <= 0) {
      lastCallTime = Date.now()
      callback.apply(this, args)
      return
    }
    timeout = setTimeout(() => {
      lastCallTime = Date.now()
      callback.apply(this, args)
    }, delay)
  }
}
