// Extra folders that travel with Forge's memory in .forgepack files and device sync, registered by
// the features that own them (e.g. the VFX library). Each top-level entry (file or folder) inside
// dir() is one pack item; it is zipped under extra/<id>/ and mirrored by sync the same way.
// Conflict copies are written next to the losing file as "<file>.conflict"; owners should ignore
// names ending in ".conflict". No electron.

export interface PackSection {
  // Folder name inside the pack (extra/<id>/); lowercase letters, digits and dashes.
  id: string
  // Shown in the export and import dialogs.
  label: string
  // The folder on this device, or null when unavailable.
  dir(): string | null
}

const sections = new Map<string, PackSection>()

export function registerPackSection(section: PackSection): () => void {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(section.id)) throw new Error(`invalid pack section id "${section.id}"`)
  sections.set(section.id, section)
  return () => {
    if (sections.get(section.id) === section) sections.delete(section.id)
  }
}

export function packSections(): PackSection[] {
  return [...sections.values()]
}
