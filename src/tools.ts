/**
 * Model-invocable OpenViking tools: search, read, browse, remember, forget,
 * ingest resources, expand session archives, tree, write, edit, grep, glob,
 * and watch management.
 * @module openviking-memory/tools
 */

import {
  defineTool,
  type InferArgs,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { OpenVikingClient } from './ov-client.ts'
import type { OpenVikingRuntime } from './runtime.ts'

export interface ToolRegistry {
  tools: {
    register(definition: unknown): void
  }
}

export function registerOpenVikingTools(ctx: ToolRegistry, client: OpenVikingClient, runtime: OpenVikingRuntime): void {
  ctx.tools.register(textTool({
    name: 'viking_search',
    description:
      'Search OpenViking memories, resources, and skills. Use this for prior decisions, preferences, and project knowledge not present in the current context.',
    parameters: {
      query: { type: 'string', required: true, description: 'Semantic search query.' },
      scope: { type: 'string', description: 'Optional viking:// URI prefix.' },
      limit: { type: 'integer', description: 'Maximum results, from 1 to 50.' },
    },
    async execute(args, exec) {
      const actorPeerId = await peerFor(runtime, exec)
      const results = await client.find(args.query, {
        targetUri: args.scope,
        limit: Math.max(1, Math.min(50, args.limit || 10)),
        actorPeerId,
      })
      if (results.length === 0) return 'No results found.'
      return results.map(result => {
        const abstract = result.abstract.length > client.config.recallMaxContentChars
          ? `${result.abstract.slice(0, client.config.recallMaxContentChars)}...`
          : result.abstract
        return `[${result.score.toFixed(2)}] ${result.uri}\n  ${abstract}`
      }).join('\n\n')
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_read',
    description:
      'Read OpenViking content by viking:// URI at abstract, overview, or full detail.',
    parameters: {
      uri: { type: 'string', required: true, description: 'The viking:// URI to read.' },
      level: {
        type: 'string',
        required: true,
        enum: ['abstract', 'overview', 'full'],
        description: 'Detail level.',
      },
    },
    async execute(args, exec) {
      const content = await client.read(
        args.uri,
        args.level,
        await peerFor(runtime, exec),
      )
      return typeof content === 'string' && content
        ? content
        : `No content at ${args.uri}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_browse',
    description: 'List an OpenViking directory or inspect metadata for a viking:// URI.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'stat'],
        description: 'Browse operation.',
      },
      uri: { type: 'string', description: 'URI to browse. Defaults to viking://.' },
    },
    async execute(args, exec) {
      const actorPeerId = await peerFor(runtime, exec)
      const uri = args.uri || 'viking://'
      if (args.action === 'stat') {
        const info = await client.stat(uri, actorPeerId)
        return info ? JSON.stringify(info, null, 2) : `Not found: ${uri}`
      }
      const entries = await client.list(uri, actorPeerId)
      if (entries.length === 0) return `Empty directory: ${uri}`
      return entries
        .map(entry => `${entry.isDir ? '[dir]' : '[file]'} ${entry.name || entry.uri}`)
        .join('\n')
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_remember',
    description:
      'Store an important fact, preference, decision, or gotcha in the current OpenViking session.',
    parameters: {
      content: { type: 'string', required: true, description: 'Fact to remember.' },
      category: {
        type: 'string',
        description: 'Optional category such as preference, decision, entity, event, or pattern.',
      },
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('viking_remember requires a calling agent')
      const state = await runtime.initialize(exec.agent)
      if (!state.ready) return 'OpenViking server is not reachable.'
      const category = args.category || 'general'
      const payload: Record<string, unknown> = {
        role: 'user',
        content: `[Remember — ${category}] ${args.content}`,
      }
      const peerId = state.config.resolvedPeerId || state.config.peerId
      if (peerId) payload.peer_id = peerId
      const response = await client.addMessage(
        state.ovSessionId,
        payload,
        peerId,
      )
      return response.ok
        ? `Remembered in OpenViking: "${args.content}" (${category})`
        : `Failed to remember: ${response.error?.message || response.error?.code || 'unknown error'}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_forget',
    description:
      'Permanently delete an OpenViking item only after the user explicitly asks to forget or delete it. Use an exact URI, or delete the strongest search match above score 0.8.',
    parameters: {
      uri: { type: 'string', description: 'Exact viking:// URI to delete.' },
      query: { type: 'string', description: 'Search query used when URI is omitted.' },
    },
    async execute(args, exec) {
      const actorPeerId = await peerFor(runtime, exec)
      let uri = args.uri
      if (!uri && args.query) {
        const results = await client.find(args.query, { limit: 1, actorPeerId })
        if (!results[0] || results[0].score <= 0.8) {
          return 'No strong match found (score > 0.8 required).'
        }
        uri = results[0].uri
      }
      if (!uri) return 'Provide either uri or query.'
      return await client.forget(uri, false, actorPeerId)
        ? `Deleted: ${uri}`
        : `Failed to delete: ${uri}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_add_resource',
    description: 'Ingest an HTTP(S) or git URL into OpenViking for indexed retrieval.',
    parameters: {
      url: { type: 'string', required: true, description: 'Remote URL to ingest.' },
      reason: { type: 'string', description: 'Why this resource is relevant.' },
    },
    async execute(args, exec) {
      const result = await client.addResource(
        args.url,
        args.reason,
        await peerFor(runtime, exec),
      )
      return result?.root_uri
        ? `Ingested: ${result.root_uri}`
        : `Failed to ingest: ${args.url}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_archive_expand',
    description: 'Read original messages from one archive in the current DSH session.',
    parameters: {
      archive_id: { type: 'string', required: true, description: 'Archive id such as archive_001.' },
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('viking_archive_expand requires a calling agent')
      const state = await runtime.initialize(exec.agent)
      const archive = await client.getSessionArchive(
        state.ovSessionId,
        args.archive_id,
        state.config.resolvedPeerId,
      )
      if (!archive) return `Archive not found: ${args.archive_id}`
      const messages = Array.isArray(archive.messages) ? archive.messages : []
      const header = [
        `## ${archive.archive_id || args.archive_id}`,
        archive.abstract ? `**Summary**: ${archive.abstract}` : '',
        `**Messages**: ${messages.length}`,
      ].filter(Boolean).join('\n')
      const body = messages.map(formatArchiveMessage).join('\n\n')
      return body ? `${header}\n\n${body}` : header
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_tree',
    description:
      'List the recursive directory tree under an OpenViking URI, optionally limited by depth.',
    parameters: {
      uri: { type: 'string', description: 'URI to tree. Defaults to the OpenViking root.' },
      level_limit: { type: 'integer', description: 'Maximum depth to traverse, from 1 to 10.' },
      node_limit: { type: 'integer', description: 'Maximum number of nodes to return.' },
    },
    async execute(args, exec) {
      const actorPeerId = await peerFor(runtime, exec)
      const uri = args.uri || 'viking://'
      const entries = await client.tree(uri, {
        nodeLimit: args.node_limit,
        levelLimit: args.level_limit,
        actorPeerId,
      })
      if (entries.length === 0) return `Empty tree: ${uri}`
      return entries.map(entry => {
        const prefix = entry.isDir ? '[dir]' : '[file]'
        const abstract = entry.abstract && entry.abstract.length > 120
          ? ` — ${entry.abstract.slice(0, 120)}...`
          : ''
        return `${prefix} ${entry.rel_path || entry.uri}${abstract}`
      }).join('\n')
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_write',
    description:
      'Write text to an OpenViking file URI (replace, append, or create). Use this to persist notes, decisions, profiles, or state.',
    parameters: {
      uri: { type: 'string', required: true, description: 'The OpenViking file URI to write.' },
      content: { type: 'string', required: true, description: 'Text content to write.' },
      mode: {
        type: 'string',
        enum: ['replace', 'append', 'create'],
        description: 'Write mode: replace (default), append, or create (fails if it already exists).',
      },
    },
    async execute(args, exec) {
      const response = await client.writeContent(
        args.uri,
        args.content,
        { mode: args.mode ?? 'replace', actorPeerId: await peerFor(runtime, exec) },
      )
      if (!response.ok) {
        return `Failed to write ${args.uri}: ${response.error?.message || response.error?.code || 'unknown error'}`
      }
      const result = (response.result ?? {}) as Record<string, unknown>
      const bytes = result.written_bytes
      return `Wrote ${bytes === undefined ? 'content' : `${bytes} bytes`} to ${result.uri || args.uri} (mode=${result.mode || args.mode || 'replace'})`
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_edit',
    description:
      'Replace an exact string with new text in an existing OpenViking file. old_string must match the current content exactly; use viking_read first.',
    parameters: {
      uri: { type: 'string', required: true, description: 'The OpenViking file URI to edit.' },
      old_string: { type: 'string', required: true, description: 'Exact text to replace.' },
      new_string: { type: 'string', required: true, description: 'Replacement text; empty string deletes old_string.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    },
    async execute(args, exec) {
      const result = await client.editContent(
        args.uri,
        args.old_string,
        args.new_string,
        { replaceAll: args.replace_all, actorPeerId: await peerFor(runtime, exec) },
      )
      return result.message
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_grep',
    description:
      'Search file contents under an OpenViking URI with a regex pattern. Use for exact text matching; viking_search is for semantic retrieval.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for.' },
      uri: { type: 'string', description: 'URI prefix to search. Defaults to the OpenViking root.' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive matching (default false).' },
      node_limit: { type: 'integer', description: 'Maximum matches to return.' },
    },
    async execute(args, exec) {
      const result = await client.grep(args.pattern, {
        uri: args.uri || 'viking://',
        caseInsensitive: args.case_insensitive,
        nodeLimit: args.node_limit,
        actorPeerId: await peerFor(runtime, exec),
      })
      const matches = result.matches ?? []
      if (matches.length === 0) {
        return `No matches found for ${JSON.stringify(args.pattern)} under ${args.uri || 'viking://'}.`
      }
      const header = `Found ${result.match_count ?? matches.length} match(es) in ${result.files_scanned ?? '?'} file(s):`
      const lines = matches.map(m => {
        const where = m.uri ? `${m.uri}${m.line ? `:${m.line}` : ''}` : '?'
        return `${where}\n  ${m.content ?? ''}`
      })
      return `${header}\n\n${lines.join('\n\n')}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_glob',
    description:
      'Find OpenViking files matching a glob pattern (e.g. **/*.md). Use for filename matching; viking_search is for content-based retrieval.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern such as **/*.md.' },
      uri: { type: 'string', description: 'Root URI to search. Defaults to the OpenViking root.' },
      node_limit: { type: 'integer', description: 'Maximum matches to return.' },
    },
    async execute(args, exec) {
      const matches = await client.glob(args.pattern, {
        uri: args.uri,
        nodeLimit: args.node_limit,
        actorPeerId: await peerFor(runtime, exec),
      })
      if (matches.length === 0) return `No files found matching: ${args.pattern}`
      return `Found ${matches.length} file(s):\n${matches.map(m => `  ${m.uri ?? String(m)}`).join('\n')}`
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_list_watches',
    description: 'List the OpenViking watch tasks that re-ingest external resources on a schedule.',
    parameters: {},
    async execute(_args, exec) {
      const tasks = await client.listWatches(await peerFor(runtime, exec))
      if (tasks.length === 0) return 'No watch tasks.'
      return tasks.map(task => {
        const state = task.is_active ? 'active' : 'paused'
        const target = task.to_uri || task.path || '?'
        return `- ${task.task_id} [${state}] ${target} (interval ${task.watch_interval ?? '?'}m)`
      }).join('\n')
    },
  }))

  ctx.tools.register(textTool({
    name: 'viking_cancel_watch',
    description: 'Cancel the OpenViking watch task targeting a URI, stopping further re-ingestion.',
    parameters: {
      uri: { type: 'string', required: true, description: 'The target URI of the watch task to cancel.' },
    },
    async execute(args, exec) {
      const ok = await client.cancelWatch(args.uri, await peerFor(runtime, exec))
      return ok
        ? `Cancelled watch on ${args.uri}`
        : `Failed to cancel watch on ${args.uri}`
    },
  }))
}

/** Presentation identity per tool: pending-card kind and title verb. */
const TOOL_PRESENTATION: Record<string, { kind: 'read' | 'other'; title: (args: Record<string, string>) => string }> = {
  viking_search: { kind: 'read', title: args => `OpenViking search: ${args.query}` },
  viking_read: { kind: 'read', title: args => `OpenViking read: ${args.uri}` },
  viking_browse: { kind: 'read', title: args => `OpenViking browse: ${args.uri ?? 'viking://'}` },
  viking_remember: { kind: 'other', title: () => 'OpenViking remember' },
  viking_forget: { kind: 'other', title: args => `OpenViking forget: ${args.uri ?? args.query ?? ''}` },
  viking_add_resource: { kind: 'other', title: args => `OpenViking ingest: ${args.url}` },
  viking_archive_expand: { kind: 'read', title: () => 'OpenViking archive expand' },
  viking_tree: { kind: 'read', title: args => `OpenViking tree: ${args.uri ?? 'root'}` },
  viking_write: { kind: 'other', title: args => `OpenViking write: ${args.uri}` },
  viking_edit: { kind: 'other', title: args => `OpenViking edit: ${args.uri}` },
  viking_grep: { kind: 'read', title: args => `OpenViking grep: ${args.pattern}` },
  viking_glob: { kind: 'read', title: args => `OpenViking glob: ${args.pattern}` },
  viking_list_watches: { kind: 'read', title: () => 'OpenViking list watches' },
  viking_cancel_watch: { kind: 'other', title: args => `OpenViking cancel watch: ${args.uri}` },
}

/**
 * All seven tools return model-facing text; `defineTool` owns parameter and
 * output JSON-schema conversion, validation wiring, and reserved-name checks.
 */
function textTool<const S extends ParameterSchemaSpec>(options: {
  name: string
  description: string
  parameters: S
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<string>
}): ToolDefinition {
  const presentation = TOOL_PRESENTATION[options.name] ?? { kind: 'other' as const, title: () => options.name }
  return defineTool<S, { type: 'string' }>({
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: InferArgs<S>, value: string) => [{ type: 'text', text: value }],
    },
    execute: options.execute,
    presentCall: (args: InferArgs<S>) => ({
      card: 'generic',
      kind: presentation.kind,
      title: presentation.title(args as Record<string, string>),
      rawInput: args,
    }),
  })
}

async function peerFor(runtime: OpenVikingRuntime, exec: ToolRunContext): Promise<string | undefined> {
  if (!exec.agent) return undefined
  return (await runtime.initialize(exec.agent)).config.resolvedPeerId
}

function formatArchiveMessage(message: Record<string, unknown>): string {
  const role = String(message?.role || 'unknown')
  const parts = Array.isArray(message?.parts) ? message.parts as Array<Record<string, unknown>> : []
  const body = parts.map(formatArchivePart).filter(Boolean).join('\n')
  return `[${role}]: ${body || '(empty)'}`
}

function formatArchivePart(part: Record<string, unknown> | null | undefined): string {
  if (!part || typeof part !== 'object') return ''
  if (part.type === 'text') return String(part.text || '')
  if (part.type === 'context') {
    return `[Context: ${part.uri || 'unknown'}]\n${part.abstract || ''}`.trim()
  }
  if (part.type === 'tool') {
    const lines = [`[Tool: ${part.tool_name || 'unknown'}]`]
    if (part.tool_input !== undefined) {
      lines.push(`Input: ${JSON.stringify(part.tool_input)}`)
    }
    if (part.tool_output) lines.push(`Output: ${part.tool_output}`)
    return lines.join('\n')
  }
  return `[${part.type || 'unknown'}]: ${JSON.stringify(part)}`
}
