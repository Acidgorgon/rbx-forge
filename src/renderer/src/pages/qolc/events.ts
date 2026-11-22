// Window events that open the Forge Doctor dialog (mounted once by QolcOverlays), so any page,
// menu or command can open it without store changes.
import type { Actions } from '../../store'
import { showSettingsSection } from '../settings/settingsNav'

export const DOCTOR_EVENT = 'forge:doctor'

export function openDoctor(): void {
  window.dispatchEvent(new CustomEvent(DOCTOR_EVENT))
}

// Doctor "open" fix targets: settings:<section id>, page:<page>, side:<view>, file:<path>.
export function goTo(target: string, actions: Actions): void {
  const [kind, ...rest] = target.split(':')
  const arg = rest.join(':')
  if (kind === 'settings') {
    actions.openPage('settings')
    showSettingsSection(arg)
  } else if (kind === 'page') actions.openPage(arg as never)
  else if (kind === 'side') actions.showSide(arg as never)
  else if (kind === 'file') void actions.openFile(arg)
}

export function openUsageSettings(actions: Actions): void {
  goTo('settings:set-usage', actions)
}
