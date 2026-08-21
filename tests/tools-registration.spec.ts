import { describe, expect, it } from 'vitest'
import { registerOpenVikingTools } from '../src/tools.ts'

// Registration-shape gate: every definition flows through the pinned
// @deepseek-ai/dsh-tools defineTool, so this test fails when a dsh rc pin
// bump changes the ToolDefinition contract these tools rely on.
describe('tool registration', () => {
  it('registers all seven tools as valid dsh ToolDefinitions', () => {
    const registered: Array<Record<string, unknown>> = []
    const ctx = { tools: { register: definition => registered.push(definition as never) } }
    registerOpenVikingTools(ctx, {} as never, {} as never)

    expect(registered.map(definition => definition.name)).toEqual([
      'viking_search',
      'viking_read',
      'viking_browse',
      'viking_remember',
      'viking_forget',
      'viking_add_resource',
      'viking_archive_expand',
    ])
    for (const definition of registered) {
      expect(typeof definition.execute).toBe('function')
      expect(typeof (definition.output as Record<string, unknown>).render).toBe('function')
      expect(((definition.output as Record<string, unknown>).schema as Record<string, unknown>).type).toBe('string')
      expect((definition.parameters as Record<string, unknown>).type).toBe('object')
      const VALID_ARGS: Record<string, Record<string, unknown>> = {
        viking_search: { query: 'q' },
        viking_read: { uri: 'viking://x', level: 'abstract' },
        viking_browse: { action: 'list' },
        viking_remember: { content: 'fact' },
        viking_forget: { uri: 'viking://x' },
        viking_add_resource: { url: 'https://y' },
        viking_archive_expand: { archive_id: 'archive_001' },
      }
      const view = (definition.presentCall as (args: Record<string, unknown>) => Record<string, unknown>)(
        VALID_ARGS[definition.name as string]!,
      )
      expect(view.card).toBe('generic')
      expect(['read', 'other']).toContain(view.kind)
      expect(typeof view.title).toBe('string')
    }

    const [search] = registered
    const rendered = (search.output as Record<string, unknown>).render as (args: unknown, value: string) => Array<{ type: string, text: string }>
    expect(rendered({}, 'hit one')).toEqual([{ type: 'text', text: 'hit one' }])
  })
})
