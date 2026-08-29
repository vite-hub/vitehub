export default function throttle<TThis, TArgs extends unknown[]>(
  callback: (this: TThis, ...args: TArgs) => void,
  wait: number,
) {
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
