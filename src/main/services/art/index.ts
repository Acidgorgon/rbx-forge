// Art / UI concept workflow (see service.ts). Barrel for main/integrations.ts and tests.
export { ArtService, ART_MODELS, DEFAULT_SETTINGS, AGENT_MAX_VARIANTS, type ArtServiceDeps } from './service.ts'
export { artTools, ART_TOOL_NAMES, type ArtToolDeps } from './tools.ts'
export { STYLE_PRESETS } from './styles.ts'
export { REGISTRY_PATH } from './registry.ts'
export { ASSET_SCOPES } from './robloxAssets.ts'

// Secret-store key for the Art Open Cloud key (falls back to the Release key when unset).
export function artSecretKey(scope?: string): string {
  return scope ? `art.openCloudApiKey.${scope}` : 'art.openCloudApiKey'
}
