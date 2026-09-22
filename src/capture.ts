/**
 * Session-event capture: turns DSH `session/event` payloads into OpenViking
 * message payloads, and builds pre-step recall queries from the final message
 * batch.
 * @module openviking-memory/capture
 */

import {
  extractPartsFromPayload,
  extractTextFromPayload,
  shouldCaptureText,
} from './shared/capture-utils.ts'
import type { OpenVikingConfig } from './config.ts'

/**
 * Message-source kind this plugin declares for the durable context messages it
 * injects.
 *
 * DSH 0.1.7 removed the shared catch-all `plugin` source kind ("each producer
 * declares its own `kind` in its own module"), so the producer name IS the
 * kind: `runtime.ts` merges this literal into `MessageSourceMap` and stamps it
 * on every profile/recall message, and {@link promptText} uses it to keep this
 * plugin's own injections out of the query it builds from the message batch.
 */
export const OPENVIKING_PLUGIN_SOURCE = 'openviking-memory'

export interface CaptureToolState {
  captureToolResults: boolean
}

/**
 * Convert one DSH session event into an OpenViking message payload, or null
 * when the event carries nothing worth capturing.
 * @param toolNames - per-callId tool-name registry retained between tool/call and tool/result.
 */
export function captureEvent(
  event: Record<string, unknown> | null | undefined,
  config: OpenVikingConfig,
  toolNames: Map<string, string> = new Map(),
): Record<string, unknown> | null {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'tool/call') {
    const data = event.data as Record<string, unknown> | undefined
    if (config.captureToolResults === true) {
      toolNames.set(String(data?.callId), String(data?.name || ''))
    }
    return null
  }

  const message = eventMessage(event)
  if (!message) return null
  const toolCallId = event.type === 'tool/result'
    ? String((message.source as Record<string, unknown> | undefined)?.callId
      || (message.content as Array<Record<string, unknown>> | undefined)?.[0]?.toolCallId
      || '')
    : ''
  try {
    return captureMessage(event, message, config, toolNames)
  } finally {
    if (toolCallId) toolNames.delete(toolCallId)
  }
}

function captureMessage(
  event: Record<string, unknown>,
  message: Record<string, unknown>,
  config: OpenVikingConfig,
  toolNames: Map<string, string>,
): Record<string, unknown> | null {
  // Whitelist by role and source kind: only genuine human input — plus, when
  // the settings allow, assistant turns and tool results — enters memory.
  // DSH 0.1.7 replaced the single shared `plugin` source kind with one kind per
  // producer (`agent-instructions`, `time-context`, `openviking-memory`, …), so
  // the rule can no longer be "skip `plugin`": anything that is not the user's
  // own message is model input, and mirroring it would launder synthetic text
  // into memory as if a person had said it.
  const source = message.source as Record<string, unknown> | undefined
  const kind = typeof source?.kind === 'string' ? source.kind : undefined
  if (message.role === 'assistant') {
    if (config.captureAssistantTurns === false) return null
  } else if (kind === 'tool') {
    if (config.captureToolResults !== true) return null
  } else if (kind !== 'user') {
    return null
  }

  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const toolNameById = Object.fromEntries(toolNames)
  const rawText = extractTextFromPayload(message, {
    toolMaxChars: config.captureToolMaxChars,
  })
  const parts = extractPartsFromPayload(message, {
    toolMaxChars: config.captureToolMaxChars,
    toolNameById,
  })
  const decision = shouldCaptureText(rawText, role, { captureMaxLength: config.captureMaxLength })
  const structuredParts = parts.filter(part => (part as { type?: string })?.type !== 'text')
  if (!decision.shouldCapture && structuredParts.length === 0) return null

  const hasTextPart = parts.some(part => (part as { type?: string })?.type === 'text')
  const bodyParts = [
    ...(hasTextPart && decision.shouldCapture && decision.text
      ? [{ type: 'text', text: decision.text }]
      : []),
    ...structuredParts,
  ]
  const payload: Record<string, unknown> = bodyParts.length > 0
    ? { role, parts: bodyParts }
    : { role, content: decision.text }
  const createdAt = eventCreatedAt(event)
  if (createdAt) payload.created_at = createdAt
  const peerId = config.resolvedPeerId || config.peerId
  if (peerId) payload.peer_id = peerId
  return payload
}

/** Build a recall query from the pre-step message batch, excluding this plugin's own injections. */
export function promptText(messages: ReadonlyArray<unknown> | null | undefined): string {
  return (messages || [])
    .map(message => message as Record<string, unknown> | undefined)
    .filter(message => (
      message
      && (message.source as Record<string, unknown> | undefined)?.kind !== OPENVIKING_PLUGIN_SOURCE
    ))
    .map(message => extractTextFromPayload(message))
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function eventMessage(event: Record<string, unknown>): Record<string, unknown> | null {
  switch (event.type) {
    case 'user/message':
      return event.data as Record<string, unknown>
    case 'assistant/message':
    case 'tool/result':
      return (event.data as Record<string, unknown>)?.message as Record<string, unknown> | undefined ?? null
    default:
      return null
  }
}

function eventCreatedAt(event: Record<string, unknown>): string {
  const time = Number(event?.time)
  if (!Number.isFinite(time) || time < 0) return ''
  try {
    return new Date(time).toISOString()
  } catch {
    return ''
  }
}
