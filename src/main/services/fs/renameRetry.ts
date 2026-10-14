import { rename } from 'node:fs/promises'

// Windows refuses to replace a file another handle has open (EPERM / EBUSY / EACCES), e.g. while
// the page lists the library during a background analysis. Retry briefly, as graceful-fs does.
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await new Promise((r) => setTimeout(r, 10 + i * 10))
    }
  }
}
