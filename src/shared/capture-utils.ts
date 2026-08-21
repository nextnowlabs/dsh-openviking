/**
 * Shared capture utilities: extract text/structured parts from harness message
 * payloads, decide whether a message is worth capturing, and sanitize captured
 * text before it enters memory.
 */
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text'])
const TOOL_CALL_TYPES = new Set([
  'tool_call',
  'toolcall',
  'tool_use',
  'tooluse',
  'function_call',
  'functioncall',
])
const TOOL_RESULT_TYPES = new Set([
  'tool_result',
  'toolresult',
  'tool_output',
  'tooloutput',
  'function_call_output',
  'functioncalloutput',
])

// Tool output is reported verbatim; the server owns truncation via
// tool_output_externalization (threshold_chars, default 20000). This cap only
// guards against pathological payloads.
const DEFAULT_TOOL_MAX_CHARS = 1000000

const ACK_RE = /^(?:ok|okay|k|yes|yep|no|nope|thanks|thank you|thx|done|收到|好的|好|嗯|可以|继续|不用|不需要|没了|好了)[.!?。！？\s]*$/i
const SLASH_COMMAND_RE = /^\/[a-z0-9_-]{1,64}\b/i
const METADATA_KEYS = [
  'session_id',
  'sessionid',
  'sessionkey',
  'conversation_id',
  'conversationid',
  'channel',
  'sender',
  'user_id',
  'userid',
  'agent_id',
  'agentid',
  'timestamp',
  'timezone',
  'cwd',
  'model',
  'permission_mode',
]

type Block = Record<string, unknown> | string | null | undefined

function normalizeType(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[-\s]/g, '_')
}

function isToolCallBlock(block: Block): boolean {
  if (!block || typeof block !== 'object') return false
  const type = normalizeType(block.type || block.kind || block.role)
  return TOOL_CALL_TYPES.has(type) || Boolean(block.tool_calls) || Boolean((block.function as Record<string, unknown> | undefined)?.name)
}

function isToolResultBlock(block: Block): boolean {
  if (!block || typeof block !== 'object') return false
  const type = normalizeType(block.type || block.kind || block.role)
  return TOOL_RESULT_TYPES.has(type) || type === 'tool' || type === 'function'
}

function oneLine(text: unknown): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

export function truncateCaptureText(text: string, maxChars = 2000): string {
  const value = String(text || '').trim()
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`
}

function stringifyCompact(value: unknown, maxChars: number): string {
  if (value == null) return ''
  if (typeof value === 'string') return truncateCaptureText(value, maxChars)
  try {
    return truncateCaptureText(JSON.stringify(value), maxChars)
  } catch {
    return truncateCaptureText(String(value), maxChars)
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (value == null || typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function blockText(block: Block): string {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  if (typeof block.output_text === 'string') return block.output_text
  if (typeof block.input_text === 'string') return block.input_text
  if (typeof block.content === 'string') return block.content
  return ''
}

function toolName(block: Block): string {
  if (!block || typeof block !== 'object') return ''
  const fn = block.function as Record<string, unknown> | undefined
  const call = block.call as Record<string, unknown> | undefined
  return oneLine(
    block.name ||
    block.tool_name ||
    block.toolName ||
    block.tool ||
    fn?.name ||
    call?.name ||
    '',
  )
}

function toolPayload(block: Block, kind: 'call' | 'result'): unknown {
  if (!block || typeof block !== 'object') return ''
  const state = block.state as Record<string, unknown> | undefined
  const fn = block.function as Record<string, unknown> | undefined
  const call = block.call as Record<string, unknown> | undefined
  if (kind === 'call') {
    return block.input ??
      state?.input ??
      block.arguments ??
      block.args ??
      block.params ??
      fn?.arguments ??
      block.command ??
      call?.input ??
      call?.arguments ??
      ''
  }
  return block.output ??
    state?.output ??
    block.result ??
    block.error ??
    state?.error ??
    block.data ??
    block.content ??
    block.text ??
    ''
}

function toolId(block: Block): string {
  if (!block || typeof block !== 'object') return ''
  return oneLine(
    block.call_id ||
    block.callId ||
    block.callID ||
    block.tool_call_id ||
    block.toolCallId ||
    block.tool_use_id ||
    block.toolUseId ||
    block.function_call_id ||
    block.functionCallId ||
    block.id ||
    '',
  )
}

function toolStatus(block: Block, kind: 'call' | 'result'): string {
  if (!block || typeof block !== 'object') return ''
  if (kind === 'call') return 'running'
  if (block.is_error || block.error || (block.state as Record<string, unknown> | undefined)?.error) return 'error'
  const status = oneLine(block.status || (block.state as Record<string, unknown> | undefined)?.status || '')
  return status || 'completed'
}

export interface ToolPart {
  type: 'tool'
  tool_id?: string
  tool_name?: string
  tool_status: string
  tool_input?: unknown
  tool_output?: string
}

function setToolInput(part: ToolPart, payload: unknown): void {
  const input = parseMaybeJson(payload)
  if (input === '' || input == null) return
  part.tool_input = typeof input === 'object' && !Array.isArray(input)
    ? input
    : { value: input }
}

function buildToolPart(
  block: Block,
  kind: 'call' | 'result',
  { toolMaxChars = DEFAULT_TOOL_MAX_CHARS, toolNameById = {} }: { toolMaxChars?: number; toolNameById?: Record<string, string> } = {},
): ToolPart {
  const id = toolId(block)
  const name = toolName(block) || (id ? toolNameById[id] : '')
  const payload = toolPayload(block, kind)
  const part: ToolPart = {
    type: 'tool',
    tool_status: toolStatus(block, kind),
  }
  if (id) part.tool_id = id
  if (name) part.tool_name = name
  if (kind === 'call') {
    setToolInput(part, payload)
  } else {
    const state = block && typeof block === 'object' ? (block.state as Record<string, unknown> | undefined) : undefined
    if (state?.input !== undefined) {
      setToolInput(part, state.input)
    }
    part.tool_output = stringifyCompact(payload, toolMaxChars)
  }
  return part
}

function formatToolBlock(block: Block, kind: 'call' | 'result', maxChars: number): string {
  const name = toolName(block)
  const payload = toolPayload(block, kind)
  const body = oneLine(stringifyCompact(payload, maxChars))
  const label = kind === 'call' ? 'tool-call' : 'tool-result'
  return body
    ? `[${label}${name ? ` ${name}` : ''}] ${body}`
    : `[${label}${name ? ` ${name}` : ''}]`
}

interface TextExtractOptions {
  toolMaxChars?: number
  toolNameById?: Record<string, string>
}

function blockToText(block: Block, options: TextExtractOptions): string {
  if (!block) return ''
  if (typeof block === 'string') return block
  if (Array.isArray(block)) return extractTextFromContent(block, options)
  if (typeof block !== 'object') return ''

  if (block.item && typeof block.item === 'object') {
    const itemText = blockToText(block.item as Block, options)
    if (itemText) return itemText
  }

  const type = normalizeType(block.type || block.kind || block.role)
  if (TEXT_BLOCK_TYPES.has(type)) return blockText(block)
  if (isToolCallBlock(block)) return formatToolBlock(block, 'call', options.toolMaxChars ?? DEFAULT_TOOL_MAX_CHARS)
  if (isToolResultBlock(block)) return formatToolBlock(block, 'result', options.toolMaxChars ?? DEFAULT_TOOL_MAX_CHARS)
  if (Array.isArray(block.content)) return extractTextFromContent(block.content, options)
  if (!type) return blockText(block)
  return ''
}

export function extractTextFromContent(content: unknown, options: TextExtractOptions = {}): string {
  const opts: TextExtractOptions = { toolMaxChars: DEFAULT_TOOL_MAX_CHARS, ...options }
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => blockToText(block, opts))
      .filter(Boolean)
      .join('\n\n')
  }
  if (typeof content === 'object') {
    return blockToText(content as Block, opts) || stringifyCompact(content, opts.toolMaxChars ?? DEFAULT_TOOL_MAX_CHARS)
  }
  return ''
}

export function extractTextFromPayload(payload: unknown, options: TextExtractOptions = {}): string {
  if (!payload || typeof payload !== 'object') return ''
  const obj = payload as Record<string, unknown>
  const chunks: string[] = []
  const directType = normalizeType(obj.type || obj.kind || obj.role)
  if (TOOL_RESULT_TYPES.has(directType) || directType === 'tool' || TOOL_CALL_TYPES.has(directType)) {
    const direct = blockToText(obj as Block, { toolMaxChars: DEFAULT_TOOL_MAX_CHARS, ...options })
    if (direct) return direct
  }

  if (obj.message && typeof obj.message === 'object') {
    const messageText = extractTextFromPayload(obj.message, options)
    if (messageText) chunks.push(messageText)
  } else if (obj.content !== undefined) {
    const contentText = extractTextFromContent(obj.content, options)
    if (contentText) chunks.push(contentText)
  }

  for (const key of ['tool_calls', 'toolCalls', 'function_call', 'functionCall', 'tool_call', 'toolCall']) {
    const value = obj[key]
    if (!value) continue
    const toolText = extractTextFromContent(value, options)
    if (toolText) chunks.push(toolText)
  }

  if (chunks.length === 0) {
    const direct = blockToText(obj as Block, { toolMaxChars: DEFAULT_TOOL_MAX_CHARS, ...options })
    if (direct) chunks.push(direct)
  }

  return chunks.join('\n\n')
}

function extractPartsFromContent(content: unknown, options: TextExtractOptions = {}): Array<unknown> {
  const opts: TextExtractOptions = { toolMaxChars: DEFAULT_TOOL_MAX_CHARS, toolNameById: {}, ...options }
  const parts: unknown[] = []
  if (!content) return parts
  if (typeof content === 'string') {
    if (content.trim()) parts.push({ type: 'text', text: content })
    return parts
  }
  if (!Array.isArray(content)) {
    const text = blockToText(content as Block, opts)
    if (text.trim()) parts.push({ type: 'text', text })
    return parts
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (isToolCallBlock(block)) {
      parts.push(buildToolPart(block, 'call', opts))
    } else if (isToolResultBlock(block)) {
      parts.push(buildToolPart(block, 'result', opts))
    } else {
      const text = blockToText(block, opts)
      if (text.trim()) parts.push({ type: 'text', text })
    }
  }
  return parts
}

export function extractPartsFromPayload(payload: unknown, options: TextExtractOptions = {}): Array<unknown> {
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const opts: TextExtractOptions = { toolMaxChars: DEFAULT_TOOL_MAX_CHARS, toolNameById: {}, ...options }
  if (obj.message && typeof obj.message === 'object') {
    return extractPartsFromPayload(obj.message, opts)
  }

  const directType = normalizeType(obj.type || obj.kind || obj.role)
  if (TOOL_CALL_TYPES.has(directType) || isToolCallBlock(obj as Block)) {
    return [buildToolPart(obj as Block, 'call', opts)]
  }
  if (TOOL_RESULT_TYPES.has(directType) || directType === 'tool' || directType === 'function') {
    return [buildToolPart(obj as Block, 'result', opts)]
  }

  const parts: unknown[] = []
  if (obj.content !== undefined) {
    parts.push(...extractPartsFromContent(obj.content, opts))
  }
  for (const key of ['tool_calls', 'toolCalls', 'function_call', 'functionCall', 'tool_call', 'toolCall']) {
    const value = obj[key]
    if (!value) continue
    if (Array.isArray(value)) {
      for (const block of value) parts.push(...extractPartsFromPayload(block, opts))
    } else {
      parts.push(...extractPartsFromPayload(value, opts))
    }
  }
  return parts
}

function stripMetadataFences(text: string): string {
  return String(text || '').replace(/```(?:json)?\s*([\s\S]*?)```/gi, (match, body: string) => {
    const lower = body.toLowerCase()
    let hits = 0
    for (const key of METADATA_KEYS) {
      const re = new RegExp(`["']?${key}["']?\\s*:`, 'i')
      if (re.test(lower)) hits += 1
    }
    return hits >= 3 ? '' : match
  })
}

function stripInjectedDigestBlocks(text: string): string {
  const lines = String(text || '').split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  let skipUntilMcpHint = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^OpenViking session archive digest:/i.test(trimmed)) {
      skipping = true
      skipUntilMcpHint = true
      continue
    }
    if (/^OpenViking memory digest:/i.test(trimmed)) {
      skipping = true
      skipUntilMcpHint = false
      continue
    }
    if (skipping) {
      if (skipUntilMcpHint) {
        if (/^More detail: use the OpenViking MCP /i.test(trimmed)) {
          skipping = false
          skipUntilMcpHint = false
        }
        continue
      }
      if (!trimmed) {
        skipping = false
        continue
      }
      if (
        /^(?:[-*]\s+|#{1,6}\s+|More detail:|Use OpenViking MCP|Latest committed archive|Resume continuity|viking:\/\/)/i.test(trimmed) ||
        /^\s{2,}\S/.test(line)
      ) {
        continue
      }
      skipping = false
    }
    out.push(line)
  }

  return out.join('\n')
}

export function sanitizeCapturedText(text: string): string {
  let value = String(text || '')
  value = value
    .replace(/\u0000/g, '')
    .replace(/<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi, ' ')
    .replace(/<relevant-memor(?:y|ies)\b[^>]*>[\s\S]*?<\/relevant-memor(?:y|ies)>/gi, ' ')
    .replace(/^\s*Sender\s*\([^)]+\)\s*```[\s\S]*?```\s*/gim, ' ')
    .replace(/^\s*Conversation (?:metadata|info):\s*```[\s\S]*?```\s*/gim, ' ')
    .replace(/^\s*\[?\d{4}-\d{2}-\d{2}[T ][^\]\n]{3,80}\]?\s*/gm, '')
    .replace(/^\s*\d{10,13}\s+/gm, '')
  value = stripMetadataFences(value)
  value = stripInjectedDigestBlocks(value)
  value = value.replace(/^\s*More detail: use the OpenViking MCP .*$/gim, ' ')
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function hasEnoughSignal(text: string): boolean {
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length || 0
  const alnum = text.match(/[a-z0-9]/gi)?.length || 0
  return cjk >= 4 || alnum >= 6 || text.length >= 12
}

function isPunctuationOnly(text: string): boolean {
  return !/[a-z0-9\u3400-\u9fff]/i.test(text)
}

export interface CaptureDecision {
  shouldCapture: boolean
  reason: string
  text: string
}

export function shouldCaptureText(text: string, _role: string, cfg: { captureMaxLength?: number } = {}): CaptureDecision {
  const maxLength = cfg.captureMaxLength || 24000
  const sanitized = sanitizeCapturedText(text)
  if (!sanitized) return { shouldCapture: false, reason: 'empty', text: '' }

  const capped = truncateCaptureText(sanitized, maxLength)
  const compact = oneLine(capped)
  const isToolSummary = /^\[tool-(?:call|result)\b/i.test(compact)

  if (!isToolSummary && _role === 'user' && SLASH_COMMAND_RE.test(compact)) {
    return { shouldCapture: false, reason: 'slash_command', text: '' }
  }
  if (!isToolSummary && ACK_RE.test(compact)) {
    return { shouldCapture: false, reason: 'ack', text: '' }
  }
  if (!isToolSummary && isPunctuationOnly(compact)) {
    return { shouldCapture: false, reason: 'punctuation', text: '' }
  }
  if (!isToolSummary && !hasEnoughSignal(compact)) {
    return { shouldCapture: false, reason: 'too_short', text: '' }
  }
  if (/^\[openviking-memory\]/i.test(compact)) {
    return { shouldCapture: false, reason: 'plugin_status', text: '' }
  }

  return { shouldCapture: true, reason: 'ok', text: capped }
}
