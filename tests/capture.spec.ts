import { describe, expect, it } from 'vitest'
import { captureEvent, promptText } from '../src/capture.ts'
import { resolveConfig } from '../src/config.ts'

const CONFIG = resolveConfig({
  captureAssistantTurns: true,
  captureToolResults: true,
  recallQueryExpansion: 'auto',
  recallLimit: 10,
  peerId: 'workspace-a',
})

describe('captureEvent', () => {
  it('captures DSH message events without recapturing injected context', () => {
    const user = captureEvent({
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'Remember that deployment uses blue.' }],
        source: { kind: 'user' },
      },
    }, CONFIG)
    expect(user).toEqual({
      role: 'user',
      parts: [{ type: 'text', text: 'Remember that deployment uses blue.' }],
      peer_id: 'workspace-a',
    })

    const injected = captureEvent({
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'text', text: '<openviking-context>blue</openviking-context>' }],
        source: { kind: 'plugin', plugin: 'openviking-memory', form: 'recall' },
      },
    }, CONFIG)
    expect(injected).toBeNull()

    // Every plugin's injections stay out of memory, not just this plugin's.
    const otherPlugin = captureEvent({
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'Time sampled while preparing turn 3' }],
        source: { kind: 'plugin', plugin: 'time-context', form: 'snapshot' },
      },
    }, CONFIG)
    expect(otherPlugin).toBeNull()
  })

  it('preserves DSH tool call identity in captured tool results', () => {
    const names = new Map<string, string>()
    expect(captureEvent({
      type: 'tool/call',
      data: { callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
    }, CONFIG, names)).toBeNull()

    const captured = captureEvent({
      type: 'tool/result',
      data: {
        message: {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: '/workspace' }],
          }],
          source: { kind: 'tool', callId: 'call-1' },
        },
      },
    }, CONFIG, names)

    expect(captured?.role).toBe('user')
    expect(captured?.parts?.[0]?.type).toBe('tool')
    expect(captured?.parts?.[0]?.tool_id).toBe('call-1')
    expect(captured?.parts?.[0]?.tool_name).toBe('bash')
    expect(String(captured?.parts?.[0]?.tool_output)).toMatch(/workspace/)
    expect(names.size).toBe(0)
  })

  it('does not retain tool call names when tool-result capture is disabled', () => {
    const names = new Map<string, string>()
    const config = resolveConfig({
      captureToolResults: false,
      recallQueryExpansion: 'auto',
      recallLimit: 10,
    })
    captureEvent({
      type: 'tool/call',
      data: { callId: 'call-disabled', name: 'bash' },
    }, config, names)
    expect(names.size).toBe(0)
  })

  it('releases tool call names even when a tool result has no capturable content', () => {
    const names = new Map<string, string>([['call-empty', 'bash']])
    const captured = captureEvent({
      type: 'tool/result',
      data: {
        message: {
          role: 'user',
          content: [],
          source: { kind: 'tool', callId: 'call-empty' },
        },
      },
    }, CONFIG, names)

    expect(captured).toBeNull()
    expect(names.size).toBe(0)
  })

  it('preserves DSH event time so identical offline messages do not deduplicate', () => {
    const captured = captureEvent({
      type: 'user/message',
      time: 1_786_681_234_567,
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'Repeat this exact fact.' }],
        source: { kind: 'user' },
      },
    }, CONFIG)

    expect(captured?.created_at).toBe('2026-08-14T04:20:34.567Z')
  })

  it('builds recall queries from current input while excluding its own context', () => {
    expect(promptText([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Current question' }],
        source: { kind: 'user' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'old recall' }],
        source: { kind: 'plugin', plugin: 'openviking-memory' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'background job completed' }],
        source: { kind: 'plugin', plugin: 'job-controller', form: 'notice', summary: 'done' },
      },
    ])).toBe('Current question\n\nbackground job completed')
  })
})
