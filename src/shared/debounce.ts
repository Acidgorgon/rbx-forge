// Trailing debounce: call() restarts the wait, fn runs once after `ms` of quiet. cancel() drops a
// pending run, flush() runs it now. Used to coalesce bursts (git status after tree changes, the
// language server's sourcemap.json notification).
export interface TrailingDebounce {
  call(): void
  cancel(): void
  flush(): void
  readonly pending: boolean
}

export function trailingDebounce(fn: () => void, ms: number): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    timer = null
    fn()
  }
  return {
    call() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, ms)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    },
    flush() {
      if (!timer) return
      clearTimeout(timer)
      run()
    },
    get pending() {
      return timer !== null
    }
  }
}
