// Window events that open the Forge Doctor and "Add to game" dialogs (mounted once by
// QolcOverlays), so any page, menu or command can open them without store changes.
// Other labs (UI Motion, Thumbnails) call openAddToGame('<their lab id>', id) once they register an
// adapter in main (services/addToGame).
import type { Actions } from '../../store'
import { showSettingsSection } from '../settingsNav'

export const DOCTOR_EVENT = 'forge:doctor'
export const ADD_TO_GAME_EVENT = 'forge:add-to-game'

export function openDoctor(): void {
  window.dispatchEvent(new CustomEvent(DOCTOR_EVENT))
}

export function openAddToGame(lab: string, id: string): void {
  window.dispatchEvent(new CustomEvent(ADD_TO_GAME_EVENT, { detail: { lab, id } }))
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
