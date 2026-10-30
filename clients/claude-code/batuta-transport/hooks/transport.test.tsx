import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'batuta-transport',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 118,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const SONG = { is_playing: false, current_song_time: 8, tempo: 95, signature: [4, 4] }

type World = { calls: { tool: string; args: unknown }[]; isLive: boolean; song: typeof SONG }

/** Stands for the engine: Batuta's tools when `hasBatuta`, Live answering while `isLive`. */
function world(on: On, hasBatuta: boolean): World {
  const seen: World = { calls: [], isLive: true, song: SONG }
  on('command.register', () => ({ value: { command: 'transport' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({
    value: hasBatuta ? [{ name: 'mcp__batutaMCP__get_transport', description: 'transport', mcp: true }] : [],
  }))
  on('mcp.call', (_, e) => {
    seen.calls.push({ tool: e.tool, args: e.args })
    return seen.isLive
      // Batuta declares no output schema, so the engine hands the plugin text
      // only: a summary line, then the result as JSON on the last line.
      ? { value: { content: [{ type: 'text', text: `Transport read.\n${JSON.stringify(seen.song)}` }], isError: false } }
      : { value: { content: [{ type: 'text', text: 'runtime_files: socket does not exist' }], isError: true } }
  })
  // What other plugins and the engine draw in the band beneath this one.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  return seen
}

async function bandText($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ ...BAND, surface })
  const line = await ui.find({ type: 'Text', text: /bar/ })
  return { ui, line }
}

test('without Batuta in the session the band never shows', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  expect(seen.calls.length).toBe(0)
  const { ui, line } = await bandText($, 'terminal')
  expect(line).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'beneath' }))?.text).toBe('beneath')
  await ui.unmount()
})

test('with Batuta and Live the band shows the position and plays, keeping what is beneath', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const { ui, line } = await bandText($, surface)
    expect(line?.text).toBe('Stopped  bar 3.1  95.0 BPM  4/4')
    expect((await ui.find({ type: 'Text', text: 'beneath' }))?.text).toBe('beneath')
    expect((await ui.find({ type: 'Button', key: 'stop' }))).toBeUndefined()
    await ui.press({ key: 'playstop' })
    expect(seen.calls.at(-1)).toEqual({ tool: 'control_transport', args: { action: 'start' } })
    await ui.press({ key: 'back' })
    expect(seen.calls.at(-1)).toEqual({ tool: 'set_song_position', args: { beats: 4 } })
    await ui.unmount()
  }
})

test('the band goes away when Live closes and comes back with it', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, true)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)

  seen.isLive = false
  await clock.advance(15_000)
  let shown = await bandText($, 'terminal')
  expect(shown.line).toBeUndefined()
  await shown.ui.unmount()

  seen.isLive = true
  await clock.advance(10_000)
  shown = await bandText($, 'terminal')
  expect(shown.line?.text).toBe('Stopped  bar 3.1  95.0 BPM  4/4')
  await shown.ui.unmount()
})

test('hide removes the band until /transport or Claude brings it back', async ($, on) => {
  const clock = mock.clock(on)
  world(on, true)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)

  let shown = await bandText($, 'terminal')
  await shown.ui.press({ key: 'hide' })
  await shown.ui.unmount()
  await clock.advance(10_000)
  shown = await bandText($, 'terminal')
  expect(shown.line).toBeUndefined()
  await shown.ui.unmount()

  await $.tool.call({ tool: 'mcp__batutaMCP__show_transport_panel' })
  shown = await bandText($, 'terminal')
  expect(shown.line?.text).toBe('Stopped  bar 3.1  95.0 BPM  4/4')
  await shown.ui.unmount()
})

test('play turns into stop while Live plays', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, true)
  seen.song = { ...seen.song, is_playing: true }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /bar/ }))?.text).toBe('Playing  bar 3.1  95.0 BPM  4/4')
  await ui.press({ key: 'playstop' })
  expect(seen.calls.at(-1)).toEqual({ tool: 'control_transport', args: { action: 'stop' } })
  await ui.unmount()
})
