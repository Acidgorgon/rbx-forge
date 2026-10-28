// Output log lines arrive one IPC event at a time (a build can print hundreds per second). Copying the
// 4000-line array and re-rendering the app per line is what made the UI stall, so the store coalesces
// them and applies a whole batch in one dispatch. Pure, no DOM (tested in test/logBatch.test.ts).

// Appends `lines` to `logs`, keeping the newest `max`. Returns `logs` itself when there is nothing to add.
export function appendCapped<T>(logs: T[], lines: T[], max: number): T[] {
  if (!lines.length) return logs
  if (lines.length >= max) return lines.slice(-max)
  const over = logs.length + lines.length - max
  return over > 0 ? [...logs.slice(over), ...lines] : [...logs, ...lines]
}

// Collects items and hands them to `flush` together once `ms` have passed since the first one arrived.
export function createBatcher<T>(flush: (items: T[]) => void, ms: number) {
  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const drain = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending.length) return
    const items = pending
    pending = []
    flush(items)
  }
  return {
    push(item: T) {
      pending.push(item)
      if (!timer) timer = setTimeout(drain, ms)
    },
    // Delivers what is queued now (unmount, or before a snapshot replaces the log).
    flush: drain,
    // Drops what is queued without delivering it.
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
    }
  }
}
