export type RcState = 'on' | 'off' | 'unknown'

declare module 'claude-code' {
  interface PluginState {
    'rc-auto': { lastTypedAt: number; rc: RcState; lastError: string }
  }
}
