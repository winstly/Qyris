/**
 * Store 共享默认值：useAppStore 和 useSettingsStore 同源，防止分叉。
 */
import type { AiSettings } from '@/types'

export const DEFAULT_SETTINGS: AiSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  provider: 'openai',
  dispatchMode: 'api',
  cliPermission: 'auto',
}
