// Model Upload / Studio Insert Inbox and Open Cloud Creator settings types.
// Relocated from artTypes.ts so the inbox works independently without the Art Lab.

export interface ModelInboxEntry {
  id: string
  name?: string
  // 'insert': a Studio insert (paths); absent: an upload (assetId).
  kind?: 'upload' | 'insert'
  status: 'done' | 'error'
  assetId?: number | string
  paths?: string[]
  error?: string
  at: string
}

export interface ModelInboxStatus {
  enabled: boolean
  // The folder in use, the default one (<Documents>/ForgeModels/_upload_inbox) and its parent root.
  dir: string
  defaultDir: string
  modelsDir: string
  robloxKey: boolean
  creator: boolean
  watching: boolean
  // Studio inserts (<id>.insert.json): their own opt-in, no Open Cloud key needed.
  insertEnabled: boolean
  recent: ModelInboxEntry[]
}

export interface InboxCloudStatus {
  robloxKey: boolean
  robloxKeySource?: 'inbox' | 'release'
  creatorUserId?: number
  creatorGroupId?: number
}

export interface InboxEvents {
  // The FBX upload inbox finished a request (a Forge toast).
  'fbxInbox:upload': ModelInboxEntry
}

export interface InboxApi {
  fbxInboxStatus(): Promise<ModelInboxStatus>
  fbxInboxSetSettings(patch: { enabled?: boolean; insert?: boolean; dir?: string | null }): Promise<ModelInboxStatus>
  // Folder picker; saves the choice. Unchanged status when cancelled.
  fbxInboxChooseFolder(): Promise<ModelInboxStatus>
  inboxCloudStatus(): Promise<InboxCloudStatus>
  inboxSetRobloxKey(key: string, scope: 'project' | 'global'): Promise<InboxCloudStatus>
  inboxClearRobloxKey(scope: 'project' | 'global'): Promise<InboxCloudStatus>
  inboxSetCreator(creator: { userId?: number | null; groupId?: number | null }): Promise<InboxCloudStatus>
}
