// Primary-action feedback. The terminal-style theme keeps motion calm, so the old ember spark burst
// is gone; callers keep calling sparks() and get a short, quiet press flash instead.
import { motionAllowed } from '../theme'

export function sparks(from: Element | null | undefined): void {
  if (!from || !motionAllowed()) return
  const el = from as HTMLElement
  el.classList.remove('flash')
  void el.offsetWidth
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 900)
}
