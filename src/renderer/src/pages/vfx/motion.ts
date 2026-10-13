// The preview autoplays only when motion is allowed (Settings > Motion and prefers-reduced-motion).
import { motionAllowed } from '../../theme'

export function prefersReducedMotion(): boolean {
  try {
    return !motionAllowed()
  } catch {
    return false
  }
}
