// Titlebar Help menu ("?" button). Entries are a plain list so other features add theirs here
// instead of editing the titlebar. "Report a bug…" fires a window event the bug-report dialog
// (qol-a) listens for.
import type { MenuEntry } from '../components/Menu'
import { Icon } from '../components/Icons'
import { openDoctor } from '../pages/qolc/events'
import type { Actions } from '../store'

export function helpMenuItems(actions: Actions): MenuEntry[] {
  return [
    { header: 'Help' },
    { label: 'Forge Doctor…', icon: <Icon name="check" />, sub: 'check toolchain, Studio, ports, sync, keys, disk', onSelect: openDoctor },
    { label: 'Report a bug…', icon: <Icon name="warn" />, sub: 'screenshot + logs, saved locally', onSelect: () => window.dispatchEvent(new CustomEvent('forge:report-bug')) },
    'separator',
    { label: 'Spending cap and usage…', icon: <Icon name="chart" />, onSelect: () => (actions.openPage('settings'), setTimeout(() => document.getElementById('set-usage')?.scrollIntoView({ block: 'start' }), 80)) },
    { label: 'Command palette', icon: <Icon name="search" />, onSelect: () => actions.openPalette('>') }
  ]
}
