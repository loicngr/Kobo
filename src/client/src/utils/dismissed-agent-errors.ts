type DismissalStorage = Pick<Storage, 'getItem' | 'setItem'>

export function errorDismissalKey(workspaceId: string): string {
  return `kobo:dismissed-agent-errors:${workspaceId}`
}

export function readDismissedAgentErrors(workspaceId: string, storage?: DismissalStorage): Set<string> {
  try {
    const values: unknown = JSON.parse((storage ?? localStorage).getItem(errorDismissalKey(workspaceId)) ?? '[]')
    return new Set(
      Array.isArray(values)
        ? values.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [],
    )
  } catch {
    return new Set()
  }
}

/** Persist acknowledgements, never mutate or delete the underlying conversation. */
export function saveDismissedAgentError(
  workspaceId: string,
  eventId: string,
  current: ReadonlySet<string>,
  storage?: DismissalStorage,
): Set<string> {
  const next = new Set([...readDismissedAgentErrors(workspaceId, storage), ...current, eventId])
  try {
    ;(storage ?? localStorage).setItem(errorDismissalKey(workspaceId), JSON.stringify([...next]))
  } catch {
    /* keep memory state if browser storage is unavailable */
  }
  return next
}
