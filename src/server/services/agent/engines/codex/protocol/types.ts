/**
 * Codex app-server JSON-RPC protocol — minimal type subset for Kōbō.
 *
 * Hand-written from the canonical generated bindings in
 * docs/superpowers/plans/codex-generated-bindings/v2/
 * and verified against the live wire capture (2026-05-11).
 *
 * Only the types needed by the Kōbō engine are included here.
 * The full generated set (85+ files) is preserved in docs/ for reference.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Codex sandbox isolation level. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Approval policy — determines which operations require explicit user approval.
 * The generated type also supports a `granular` object variant; Kōbō only
 * uses the simple string literals.
 */
export type AskForApproval = 'never' | 'on-request' | 'on-failure' | 'unless-trusted' | 'untrusted'

/** Reasoning effort level passed to the model. */
export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Codex's own session-level "mode" concept — independent from sandbox/approval.
 * Gates features like the `request_user_input` internal tool: only available
 * when `mode = 'plan'`. Set per-turn via `TurnStartParams.collaborationMode`.
 *
 * Kōbō's `plan` permission mode maps to `'plan'` here. All other Kōbō modes
 * leave the field unset (Codex defaults to `'default'`).
 */
export type ModeKind = 'plan' | 'default'

export type CollaborationMode = {
  mode: ModeKind
  settings: {
    model: string
    reasoning_effort: ModelReasoningEffort | null
    developer_instructions: string | null
  }
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

/**
 * Client-declared capabilities negotiated during initialize.
 * `experimentalApi: true` is REQUIRED to use experimental fields such as
 * `turn/start.collaborationMode`. Without it Codex rejects the call with
 * `-32600: turn/start.collaborationMode requires experimentalApi capability`.
 */
export type InitializeCapabilities = {
  experimentalApi: boolean
  optOutNotificationMethods?: string[] | null
}

export type InitializeParams = {
  clientInfo: { name: string; version: string }
  capabilities?: InitializeCapabilities | null
}

/**
 * Actual wire shape confirmed by live capture (2026-05-11).
 * NOT `{ serverInfo, capabilities }` as originally planned.
 */
export type InitializeResponse = {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

// ---------------------------------------------------------------------------
// UserInput (subset — text and local image only)
// ---------------------------------------------------------------------------

export type UserInput = { type: 'text'; text: string } | { type: 'localImage'; path: string }

// ---------------------------------------------------------------------------
// Thread / ThreadStart
// ---------------------------------------------------------------------------

export type ThreadStartParams = {
  cwd?: string | null
  model?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  modelReasoningEffort?: ModelReasoningEffort | null
  baseInstructions?: string | null
  config?: Record<string, unknown> | null
  skipGitRepoCheck?: boolean
  /** Required — set to false for normal operation. */
  experimentalRawEvents: boolean
  /** Required — set to false (deprecated but still required). */
  persistExtendedHistory: boolean
}

/** Minimal thread shape returned by thread/start and thread/resume. */
export type Thread = {
  id: string
  sessionId: string
  preview: string
  ephemeral: boolean
  modelProvider: string
  createdAt: number
  updatedAt: number
  cwd?: string
  path?: string | null
}

export type ThreadStartResponse = {
  thread: Thread
}

// ---------------------------------------------------------------------------
// ThreadResume
// ---------------------------------------------------------------------------

export type ThreadResumeParams = {
  threadId: string
  cwd?: string | null
  model?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  modelReasoningEffort?: ModelReasoningEffort | null
  baseInstructions?: string | null
  config?: Record<string, unknown> | null
  /** Required — set to false (deprecated but still required). */
  persistExtendedHistory: boolean
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export type TurnStartParams = {
  threadId: string
  input: UserInput[]
  /**
   * Optional CollaborationMode override. When set, Codex applies the named
   * mode for this turn (and onward). Setting `{ mode: 'plan', ... }` is the
   * only way to unlock the `request_user_input` internal tool — sandbox
   * read-only alone is not enough.
   */
  collaborationMode?: CollaborationMode | null
}

export type TurnStartResponse = {
  turnId: string
}

export type TurnInterruptParams = {
  threadId: string
  turnId?: string
}

// ---------------------------------------------------------------------------
// ThreadItem union
// ---------------------------------------------------------------------------

export type AgentMessageItem = {
  id: string
  type: 'agentMessage'
  text: string
}

export type ReasoningItem = {
  id: string
  type: 'reasoning'
  /** Aggregated summary lines. */
  summary: string[]
  content: string[]
}

export type CommandExecutionItem = {
  id: string
  type: 'commandExecution'
  command: string
  aggregatedOutput: string | null
  exitCode: number | null
  status: 'inProgress' | 'completed' | 'failed'
}

/** Discriminated change kind from the v2 protocol (`PatchChangeKind`). */
export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }

/** Per-file unified-diff payload (`FileUpdateChange`). */
export type FileUpdateChange = {
  path: string
  kind: PatchChangeKind
  diff: string
}

export type FileChangeItem = {
  id: string
  type: 'fileChange'
  changes: FileUpdateChange[]
  status: 'completed' | 'failed'
}

export type McpToolCallItem = {
  id: string
  type: 'mcpToolCall'
  server: string
  tool: string
  arguments: unknown
  result?: { content: unknown[]; structured_content?: unknown } | null
  error?: { message: string } | null
  status: 'inProgress' | 'completed' | 'failed'
}

export type WebSearchItem = {
  id: string
  type: 'webSearch'
  query: string
}

/** Status of a single sub-agent tracked by `collabAgentToolCall.agentsStates`. */
export type CollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound'

/** Tool variant invoked by the parent agent (verb of the collab call). */
export type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent'

export type CollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed'

/**
 * Codex's analogue of Claude's Task tool. Emitted on `item/started` /
 * `item/completed` when the agent calls `spawnAgent` (and family). Kōbō maps
 * these into `subagent:progress` events so the sub-agents UI panel works.
 */
export type CollabAgentToolCallItem = {
  id: string
  type: 'collabAgentToolCall'
  tool: CollabAgentTool
  status: CollabAgentToolCallStatus
  senderThreadId: string
  receiverThreadIds: string[]
  prompt: string | null
  model: string | null
  reasoningEffort?: ModelReasoningEffort | null
  agentsStates: Record<string, { status: CollabAgentStatus; message: string | null }>
}

/** Generic tool registered dynamically by Codex (custom tools / extensions). */
export type DynamicToolCallStatus = 'inProgress' | 'completed' | 'failed'

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }

export type DynamicToolCallItem = {
  id: string
  type: 'dynamicToolCall'
  namespace: string | null
  tool: string
  arguments: unknown
  status: DynamicToolCallStatus
  contentItems: DynamicToolCallOutputContentItem[] | null
  success: boolean | null
  durationMs: number | null
}

/** Agent opened an image file. */
export type ImageViewItem = {
  id: string
  type: 'imageView'
  path: string
}

/** Agent generated an image (returns a saved path or URL). */
export type ImageGenerationItem = {
  id: string
  type: 'imageGeneration'
  status: string
  revisedPrompt: string | null
  result: string
  savedPath?: string
}

/** Codex's self-review mode boundary markers. */
export type EnteredReviewModeItem = { id: string; type: 'enteredReviewMode'; review: string }
export type ExitedReviewModeItem = { id: string; type: 'exitedReviewMode'; review: string }

/** Codex compacted its own context (analogous to Claude's session compaction). */
export type ContextCompactionItem = { id: string; type: 'contextCompaction' }

/** A todo list maintained by the agent (type name from generated bindings). */
export type TodoListItem = {
  id: string
  type: 'plan'
  text: string
}

export type ErrorItem = {
  id: string
  type: 'error'
  message: string
}

/** User message item echoed back in the stream. */
export type UserMessageItem = {
  id: string
  type: 'userMessage'
  content: UserInput[]
}

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem
  | UserMessageItem
  | CollabAgentToolCallItem
  | DynamicToolCallItem
  | ImageViewItem
  | ImageGenerationItem
  | EnteredReviewModeItem
  | ExitedReviewModeItem
  | ContextCompactionItem

// ---------------------------------------------------------------------------
// Notifications — Server → Client (push)
// ---------------------------------------------------------------------------

export type ItemStartedNotification = {
  item: ThreadItem
  threadId: string
  turnId: string
  startedAtMs: number
}

export type ItemCompletedNotification = {
  item: ThreadItem
  threadId: string
  turnId: string
  completedAtMs: number
}

export type TurnCompletedNotification = {
  threadId: string
  turn: {
    id: string
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
    startedAt: number | null
    completedAt: number | null
    durationMs: number | null
    error: { message: string } | null
  }
}

export type AgentMessageDeltaNotification = {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export type ErrorNotification = {
  message: string
}

// ---------------------------------------------------------------------------
// Server-initiated requests — Codex asks us, we must respond
// ---------------------------------------------------------------------------

export type CommandExecutionRequestApprovalParams = {
  threadId: string
  turnId: string
  itemId: string
  command?: string | null
  cwd?: string | null
  reason?: string | null
}

export type CommandExecutionRequestApprovalResponse = {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
}

export type FileChangeRequestApprovalParams = {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
}

export type FileChangeRequestApprovalResponse = {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
}

export type ToolRequestUserInputOption = {
  label: string
  description?: string
}

export type ToolRequestUserInputQuestion = {
  id: string
  question: string
  header?: string
  options?: ToolRequestUserInputOption[] | null
  isOther?: boolean
  isSecret?: boolean
}

export type ToolRequestUserInputParams = {
  threadId: string
  turnId: string
  itemId: string
  questions: ToolRequestUserInputQuestion[]
}

export type ToolRequestUserInputResponse = {
  answers: Record<string, { answers: string[] }>
}
