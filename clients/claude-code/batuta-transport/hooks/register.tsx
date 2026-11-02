import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { Transport } from '../types'

const SERVER = 'batutaMCP'
const TOOL_PREFIX = 'mcp__batutaMCP__'
// Poll every second while Live plays, every fourth second while it is stopped;
// while Batuta or Live is missing, look for it every fifth second.
const TICK_MS = 1000
const IDLE_TICKS = 4
const DETECT_TICKS = 5
// One miss can be a busy moment; two in a row mean Live closed.
const MISSES_TO_DROP = 2
// The Remote Script binds this socket while Live runs (the server's default
// runtime directory). While it is missing nothing calls Batuta, so a closed
// Live raises no failed MCP tasks in the transcript.
const SOCKET = 'Library/Application Support/BatutaMCP/live.sock'

const OFFLINE: Transport = {
  isConnected: false,
  isPlaying: false,
  beats: 0,
  tempo: 120,
  signature: [4, 4],
}

// Change the tag when Transport's fields change: it declines what an earlier
// version stored, which outlives a reload.
const transport = atom({ plugin: 'batuta-transport', key: 'transport' } as const, OFFLINE, {
  shape: 'transport-1',
})
// The person hid the band: it stays hidden until Live closes and comes back,
// /transport, or Claude asks Batuta for the transport panel.
const isHidden = atom({ plugin: 'batuta-transport', key: 'isHidden' } as const, false)

type Fields = Record<string, unknown>

/**
 * The script result Batuta returns, or nothing. Batuta declares no output
 * schema, so the engine may hand over text only: its last line is the same
 * result as JSON.
 */
function fieldsOf(result: McpToolResult): Fields | undefined {
  const data = result.structuredContent
  if (typeof data === 'object' && data !== null) return data as Fields
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  const last = block?.text?.trim().split('\n').at(-1) ?? ''
  if (!last.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(last)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Fields) : undefined
  } catch {
    return undefined
  }
}

function errorText(result: McpToolResult): string {
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  return (block?.text ?? 'Batuta did not answer').split('\n')[0]?.slice(0, 120) ?? ''
}

/** Merges the fields a transport call returned into the last known state. */
function merge(last: Transport, data: Fields): Transport {
  const signature = Array.isArray(data.signature) && data.signature.length === 2
    ? [Number(data.signature[0]), Number(data.signature[1])] as [number, number]
    : last.signature
  return {
    isConnected: true,
    isPlaying: typeof data.is_playing === 'boolean' ? data.is_playing : last.isPlaying,
    beats: typeof data.current_song_time === 'number' ? data.current_song_time : last.beats,
    tempo: typeof data.tempo === 'number' ? data.tempo : last.tempo,
    signature,
  }
}

/** Beats in one bar of the current signature (a quarter note is one beat). */
function beatsPerBar(signature: [number, number]): number {
  const [numerator, denominator] = signature
  return numerator > 0 && denominator > 0 ? (numerator * 4) / denominator : 4
}

/** Position as Live shows it: bar.beat, both counted from 1. */
function position(state: Transport): string {
  const bar = beatsPerBar(state.signature)
  const barNumber = Math.floor(state.beats / bar) + 1
  const beat = Math.floor((state.beats % bar) / (4 / state.signature[1])) + 1
  return `${barNumber}.${beat}`
}

// The module's own variables start over on a reload, as the poll does.
let isDetected = false
let misses = 0
let ticks = 0

/**
 * Calls one Batuta tool and folds its result into the band's state; Live
 * counts as gone only after MISSES_TO_DROP misses in a row. Resolves whether
 * Live answered.
 */
async function call($: EngineInterface, tool: string, args?: Fields): Promise<boolean> {
  let result: McpToolResult
  try {
    result = await $.mcp.call(SERVER, tool, args)
  } catch (error) {
    result = { content: [{ type: 'text', text: String(error) }], isError: true } as McpToolResult
  }
  const data = fieldsOf(result)
  const isAnswered = !result.isError && data !== undefined
  misses = isAnswered ? 0 : misses + 1
  const last = await read($, transport)
  if (isAnswered) {
    await update($, transport, () => merge(last, data))
  } else if (misses >= MISSES_TO_DROP && last.isConnected) {
    await update($, transport, () => ({ ...last, isConnected: false, isPlaying: false, error: errorText(result) }))
    await update($, isHidden, () => false)
  }
  return isAnswered
}

/** True when this session has the Batuta MCP server's tools. */
async function hasBatuta($: EngineInterface): Promise<boolean> {
  const tools = await $.tool.list()
  return tools.some(tool => tool.name.startsWith(TOOL_PREFIX))
}

/**
 * True when Live's socket is there, or when the home folder is unknown (then
 * the call itself decides). A missing socket marks Live gone at once.
 */
async function hasSocket($: EngineInterface): Promise<boolean> {
  const home = await $.env.get('HOME')
  if (home === undefined) return true
  const isThere = await $.fs.exists(`${home}/${SOCKET}`).catch(() => true)
  if (!isThere) {
    misses = MISSES_TO_DROP
    const last = await read($, transport)
    if (last.isConnected) {
      await update($, transport, () => ({ ...last, isConnected: false, isPlaying: false, error: 'Live is closed' }))
      await update($, isHidden, () => false)
    }
  }
  return isThere
}

/** Shows the band again and reads Live at once. */
async function reveal($: EngineInterface): Promise<boolean> {
  isDetected = true
  await update($, isHidden, () => false)
  if (!(await hasSocket($))) return false
  return call($, 'get_transport')
}

/**
 * One poll step. Until Batuta's tools show up nothing is called; then Live is
 * probed every fifth second while it is away, and read while it is there.
 */
async function tick($: EngineInterface) {
  ticks += 1
  if (!isDetected) {
    if (ticks % DETECT_TICKS === 0) isDetected = await hasBatuta($)
    return
  }
  const state = await read($, transport)
  const every = !state.isConnected ? DETECT_TICKS : state.isPlaying ? 1 : IDLE_TICKS
  if (ticks % every !== 0) return
  if (await hasSocket($)) await call($, 'get_transport')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'transport',
      description: 'Show the Ableton Live transport bar above the prompt (BatutaMCP)',
    })
    // MCP servers connect after the session starts, and Live opens and
    // closes on its own: the poll decides when the band shows.
    $.clock.every(TICK_MS, () => tick($))

    return next(e)
  })

  on('command.run', { command: 'transport' }, async $ => {
    if (!(await hasBatuta($))) {
      return { text: 'BatutaMCP is not connected in this session, so the transport bar stays hidden.' }
    }
    if (!(await reveal($))) {
      return { text: 'Live is not answering (closed, or another client holds BatutaMCP); the bar shows when it does.' }
    }

    return { text: 'Live transport bar shown above the prompt.' }
  })

  // Claude asking Batuta for the panel shows the band: Claude Code does not
  // draw MCP Apps, so the band is the panel here.
  on('tool.call', { tool: `${TOOL_PREFIX}show_transport_panel` }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await reveal($)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, transport)
    const isShown = isDetected && state.isConnected && !e.props.hasSurvey && !(await read($, isHidden))
    if (!isShown) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    // Whatever other plugins draw here stays, below the transport row.
    const beneath = await next(e)
    const bar = beatsPerBar(state.signature)
    const seek = (beats: number) => call($, 'set_song_position', { beats: Math.max(0, beats) })
    // Snap to the bar line first, as Live's own back/forward does.
    const barStart = Math.floor(state.beats / bar) * bar
    const back = () => seek(state.beats - barStart > 0.01 ? barStart : barStart - bar)
    const forward = () => seek(barStart + bar)

    // The border takes two rows; a band too short for it keeps the bare row.
    const isFramed = e.props.maxRows >= 3

    return (
      <Box flexDirection="column">
        <Box
          alignSelf="flex-start"
          alignItems="center"
          gap={1}
          {...(isFramed ? { borderStyle: 'round', borderColor: 'claude', borderDimColor: !state.isPlaying, paddingX: 1 } : {})}
        >
          <Button key="home" plain label={'⏮'} onPress={() => seek(0)} />
          <Button key="back" plain label={'⏪'} onPress={back} />
          {/* One button: play while Live is stopped, stop while it plays. */}
          <Button
            key="playstop"
            plain
            label={state.isPlaying ? '\u23F9' : '\u25B6'}
            onPress={() => call($, 'control_transport', { action: state.isPlaying ? 'stop' : 'start' })}
          />
          <Button key="forward" plain label={'⏩'} onPress={forward} />
          <Text dimColor>{'│'}</Text>
          <Text bold={state.isPlaying} dimColor={!state.isPlaying}>
            {state.isPlaying ? 'Playing' : 'Stopped'}  bar {position(state)}  {state.tempo.toFixed(1)} BPM  {state.signature[0]}/{state.signature[1]}
          </Text>
          <Text dimColor>{'│'}</Text>
          <Button key="hide" plain role="dismiss" label={'×'} onPress={() => update($, isHidden, () => true)} />
        </Box>
        {beneath}
      </Box>
    )
  })
}
