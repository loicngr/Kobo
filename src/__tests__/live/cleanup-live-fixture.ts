export async function cleanupLiveFixture(
  options: {
    stop: (() => Promise<void>)[]
    close: (() => void | Promise<void>)[]
    restore: () => void
    remove: () => void
    directory: string
  },
  errors: unknown[] = [],
) {
  let stopped = true
  try {
    for (const stop of options.stop) {
      try {
        await stop()
      } catch (error) {
        stopped = false
        errors.push(error)
      }
    }
  } finally {
    try {
      for (const close of options.close) {
        try {
          await close()
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      try {
        options.restore()
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (stopped) {
    try {
      options.remove()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      stopped ? 'Live fixture failed' : `Runtime closure unconfirmed; temporary files retained at ${options.directory}`,
    )
}
