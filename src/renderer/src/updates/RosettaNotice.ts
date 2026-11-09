// The Intel build running under Rosetta on an Apple Silicon Mac makes everything slow. main sets
// UpdateState.rosettaDownload (the Apple Silicon dmg of this version); this shows a toast that stays
// until dismissed, once per session.
import { useEffect } from 'react'
import { useActions } from '../store'
import { useUpdate } from './useUpdate'

let shown = false

export function useRosettaNotice(): void {
  const url = useUpdate()?.rosettaDownload
  const actions = useActions()
  useEffect(() => {
    if (!url || shown) return
    shown = true
    actions.toast({
      text: 'Forge is running the Intel version on an Apple chip, so everything is slower. Install the Apple Silicon version.',
      kind: 'info',
      ms: 0,
      action: { label: 'Download Apple Silicon version', run: () => void window.open(url, '_blank') }
    })
  }, [url, actions])
}
