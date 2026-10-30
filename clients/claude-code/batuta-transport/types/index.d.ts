export type Transport = {
  isConnected: boolean
  isPlaying: boolean
  beats: number
  tempo: number
  signature: [number, number]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'batuta-transport': { transport: Shaped<Transport>; isHidden: boolean }
  }
}
