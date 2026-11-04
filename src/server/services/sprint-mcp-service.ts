import { SPRINT_TOOLS } from '../../shared/sprint-tools.js'
import * as sprint from './sprint-service.js'
import { getWorkspace } from './workspace-service.js'

export async function executeSprintTool(name: string, args: Record<string, unknown>) {
  const tool = SPRINT_TOOLS.find((item) => item.name === name)
  if (
    !tool ||
    Object.keys(args).some((key) => !Object.hasOwn(tool.inputSchema.properties ?? {}, key)) ||
    tool.inputSchema.required?.some((key) => !Object.hasOwn(args, key))
  )
    throw new Error('Invalid sprint tool arguments')
  if (name === 'list_sprints') return { sprints: sprint.listSprints().map(({ id, name }) => ({ id, name })) }
  if (name === 'create_sprint') return { sprint: sprint.createSprint(args.name) }
  if (name === 'reorder_sprints') return { sprints: sprint.reorderSprints(args.ids) }
  if (name === 'rename_sprint' || name === 'delete_sprint') {
    sprint.validateSprintId(args.sprint_id)
    if (args.sprint_id === null) throw new Error('Invalid sprint ID')
    return name === 'rename_sprint'
      ? { sprint: sprint.renameSprint(args.sprint_id, args.name) }
      : { workspaceIds: sprint.deleteSprint(args.sprint_id) }
  }
  if (typeof args.workspace_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(args.workspace_id))
    throw new Error('Invalid workspace ID')
  if (name === 'assign_workspace_sprint') {
    const workspace = await sprint.assignSprint(args.workspace_id, args.sprint_id)
    return { workspaceId: workspace.id, sprintId: workspace.sprintId }
  }
  const workspace = getWorkspace(args.workspace_id)
  if (!workspace) throw new Error('Workspace not found')
  return { workspaceId: workspace.id, sprintId: workspace.sprintId }
}
