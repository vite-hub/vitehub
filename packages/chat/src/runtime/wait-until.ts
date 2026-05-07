export async function flushWaitUntilTasks(tasks: Promise<unknown>[]) {
  const results = await Promise.allSettled(tasks)
  const rejection = results.find(result => result.status === "rejected")
  if (rejection) {
    throw rejection.reason
  }
}
