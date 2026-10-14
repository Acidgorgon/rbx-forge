// "Don't ask again" for the delete confirmations (Settings > Editor turns them back on). A delete that
// would lose unsaved editor changes is always confirmed.
export function shouldConfirmDelete(confirmSetting: boolean | undefined, unsavedTabs: number): boolean {
  return confirmSetting !== false || unsavedTabs > 0
}
