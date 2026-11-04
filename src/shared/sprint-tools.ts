import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const id = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }
const workspaceId = { ...id, maxLength: 200 }
const nullableId = { anyOf: [id, { type: 'null' }] }
function tool(
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
  readOnly = false,
): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
  }
}
export const SPRINT_TOOLS: Tool[] = [
  tool('list_sprints', 'List sprint IDs and names without membership or activity.', {}, [], true),
  tool(
    'get_workspace_sprint',
    'Read the sprint assignment of the selected workspace.',
    { workspace_id: workspaceId },
    ['workspace_id'],
    true,
  ),
  tool(
    'assign_workspace_sprint',
    'Assign the selected workspace to a sprint or null.',
    { workspace_id: workspaceId, sprint_id: nullableId },
    ['workspace_id', 'sprint_id'],
  ),
  tool('create_sprint', 'Create a sprint.', { name: { type: 'string', minLength: 1, maxLength: 100 } }, ['name']),
  tool('rename_sprint', 'Rename a sprint.', { sprint_id: id, name: { type: 'string', minLength: 1, maxLength: 100 } }, [
    'sprint_id',
    'name',
  ]),
  tool('reorder_sprints', 'Reorder the complete sprint catalogue.', { ids: { type: 'array', items: id } }, ['ids']),
  tool('delete_sprint', 'Delete a sprint and clear its assignments.', { sprint_id: id }, ['sprint_id']),
]
export const MANAGED_SPRINT_TOOLS = SPRINT_TOOLS.map(
  (item): Tool =>
    item.name !== 'get_workspace_sprint' && item.name !== 'assign_workspace_sprint'
      ? item
      : {
          ...item,
          description: `${item.description} Bound to this launch workspace; omit workspace_id.`,
          inputSchema: {
            ...item.inputSchema,
            required: item.inputSchema.required?.filter((key) => key !== 'workspace_id'),
          },
        },
)
export const isSprintTool = (name: string) => SPRINT_TOOLS.some((tool) => tool.name === name)
