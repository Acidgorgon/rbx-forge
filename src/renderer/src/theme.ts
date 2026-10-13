import { useEffect, useState } from 'react'

const query = () => window.matchMedia('(prefers-color-scheme: light)')

// Follows the OS appearance (Electron mirrors nativeTheme into prefers-color-scheme).
export function useTheme(): 'dark' | 'light' {
  const [light, setLight] = useState(() => query().matches)
  useEffect(() => {
    const mq = query()
    const on = () => setLight(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return light ? 'light' : 'dark'
}
