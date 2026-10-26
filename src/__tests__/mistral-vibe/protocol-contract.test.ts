import { readFileSync } from 'node:fs'
import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

type Record = {
  provenance: string
  direction: 'client' | 'agent'
  message: {
    id?: number
    method?: string
    params?: unknown
    result?: unknown
  }
}

const transcript: Record[] = readFileSync(new URL('../fixtures/mistral-acp/transcript.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const resumeIndex = transcript.findIndex((record, index) => index > 0 && record.message.method === 'initialize')
const launches = [transcript.slice(0, resumeIndex), transcript.slice(resumeIndex)]

function notificationIdentity({ sessionId, update }: acp.SessionNotification) {
  return {
    sessionId,
    sessionUpdate: update.sessionUpdate,
    ...('toolCallId' in update ? { toolCallId: update.toolCallId } : {}),
    ...('messageId' in update ? { messageId: update.messageId } : {}),
  }
}

function expectAllNotifications(received: acp.SessionNotification[], expected: acp.SessionNotification[]) {
  // Compare identities rather than fields the SDK can normalize with defaults.
  expect(received.map(notificationIdentity)).toEqual(expected.map(notificationIdentity))
}

describe('Mistral Vibe ACP contract', () => {
  it('uses the ACP v1 SDK entrypoint', () => {
    expect(acp.PROTOCOL_VERSION).toBe(1)
  })

  it.each(launches.map((records, index) => ({ records, name: index === 0 ? 'new' : 'load' })))(
    'checks the captured $name response contract and every SDK-validated update',
    async ({ records, name }) => {
      const updates: acp.SessionNotification[] = []
      const expectedUpdates: acp.SessionNotification[] = []
      let permissionCount = 0
      let questionCount = 0
      const app = acp
        .client({ name: 'kobo-contract-test' })
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          updates.push(params)
        })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
          permissionCount++
          expect(Object.keys(params.toolCall)).toEqual(['toolCallId'])
          expect(params.options.map((option) => option.optionId)).toEqual([
            'allow_once',
            'allow_always',
            'allow_always_permanent',
            'reject_once',
          ])
          expect(
            updates.some(
              ({ update }) =>
                (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
                update.toolCallId === params.toolCall.toolCallId &&
                typeof update._meta?.tool_name === 'string',
            ),
          ).toBe(true)
          return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
        })
        .onRequest(acp.methods.client.elicitation.create, ({ params }) => {
          questionCount++
          expect(acp.CreateElicitationRequest.isForm(params)).toBe(true)
          if (!acp.CreateElicitationRequest.isForm(params)) throw new Error('Expected form')
          expect(params.requestedSchema.required).toEqual(['q0', 'q1'])
          expect(params.requestedSchema.properties?.q0?.type).toBe('string')
          expect(params.requestedSchema.properties?.q1?.type).toBe('array')
          return { action: 'accept', content: { q0: 'One', q1: ['One', 'Two'] } }
        })

      async function replay({ method, client }: acp.AgentRequestContext<unknown>) {
        const start = records.findIndex((record) => record.direction === 'client' && record.message.method === method)
        const id = records[start]?.message.id
        const end = records.findIndex(
          (record, index) =>
            index > start && record.direction === 'agent' && !record.message.method && record.message.id === id,
        )
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        for (const { direction, message } of records.slice(start + 1, end)) {
          if (direction !== 'agent' || !message.method) continue
          if (message.id === undefined) {
            if (message.method === acp.methods.client.session.update) {
              expectedUpdates.push(message.params as acp.SessionNotification)
            }
            await client.notify(message.method, message.params)
          } else await client.request(message.method, message.params)
        }
        return records[end]?.message.result
      }

      const peer = acp
        .agent({ name: 'captured-vibe-3.0.1' })
        .onRequest(acp.methods.agent.initialize, async (ctx) => replay(ctx) as Promise<acp.InitializeResponse>)
        .onRequest(acp.methods.agent.session.new, async (ctx) => replay(ctx) as Promise<acp.NewSessionResponse>)
        .onRequest(acp.methods.agent.session.load, async (ctx) => replay(ctx) as Promise<acp.LoadSessionResponse>)
        .onRequest(acp.methods.agent.session.prompt, async (ctx) => replay(ctx) as Promise<acp.PromptResponse>)

      await app.connectWith(peer, async (agent) => {
        const initialized = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: { elicitation: { form: {} } },
        })
        expect(initialized.protocolVersion).toBe(1)
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        expect(initialized.agentInfo?.version).toBe('3.0.1')
        const setup = records.find((record) => record.message.method === `session/${name}`)
        const configured =
          name === 'new'
            ? await agent.request(acp.methods.agent.session.new, setup?.message.params as acp.NewSessionRequest)
            : await agent.request(acp.methods.agent.session.load, setup?.message.params as acp.LoadSessionRequest)
        if (name === 'new') expect(configured).toHaveProperty('sessionId', 'session-fixture')
        expect(configured.modes?.currentModeId).toBe('ask')
        expect(configured.modes?.availableModes.map((mode) => mode.id)).toEqual(['ask', 'accept-edits', 'auto-approve'])
        expect(configured.configOptions?.map((option) => option.id)).toEqual(['mode', 'model', 'thinking'])
        expect(configured.configOptions).toMatchObject([
          { id: 'mode', type: 'select', category: 'mode', currentValue: 'ask' },
          { id: 'model', type: 'select', category: 'model', currentValue: 'probe' },
          { id: 'thinking', type: 'select', category: 'thinking', currentValue: 'off' },
        ])
        for (const option of configured.configOptions ?? []) {
          expect(option.name).toEqual(expect.any(String))
          if (option.type === 'select') {
            expect(option.options).toContainEqual(expect.objectContaining({ value: option.currentValue }))
          }
        }
        expectAllNotifications(updates, expectedUpdates)
        if (name === 'load') {
          const usage = updates.find(({ update }) => update.sessionUpdate === 'usage_update')
          expect(usage?.update._meta?.promptTokens).toBe(50)
          expect(usage?.update._meta?.completionTokens).toBe(25)
          expect(updates.some(({ update }) => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
        }
        const result = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: 'session-fixture',
          prompt: [{ type: 'text', text: 'Replay the captured offline probe.' }],
        })
        expect(result.stopReason).toBe('end_turn')
        // Stable fluent responses are unchecked passthrough, including native usage.
        const usage = (
          result as acp.PromptResponse & {
            usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
          }
        ).usage
        for (const count of [usage?.inputTokens, usage?.outputTokens, usage?.totalTokens]) {
          expect(Number.isFinite(count)).toBe(true)
          expect(count).toBeGreaterThanOrEqual(0)
        }
        expect(usage).toEqual(
          name === 'new'
            ? { inputTokens: 50, outputTokens: 25, totalTokens: 75 }
            : { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        )
        expectAllNotifications(updates, expectedUpdates)
        expectAllNotifications(
          updates,
          records
            .filter(
              ({ direction, message }) => direction === 'agent' && message.method === acp.methods.client.session.update,
            )
            .map(({ message }) => message.params as acp.SessionNotification),
        )
        expect(permissionCount).toBe(3)
        expect(questionCount).toBe(1)
        expect(JSON.stringify(updates)).toContain(name === 'new' ? 'first-launch' : 'second-launch')
      })
    },
  )

  it('detects a malformed notification silently dropped by the SDK', async () => {
    const received: acp.SessionNotification[] = []
    const malformed = {
      sessionId: 'session-fixture',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 17, status: 'completed' },
    }
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      received.push(params)
    })
    const peer = acp.agent().onRequest(acp.methods.agent.session.prompt, async ({ client }) => {
      await client.notify<unknown>(acp.methods.client.session.update, malformed)
      return { stopReason: 'end_turn' }
    })
    try {
      await app.connectWith(peer, async (agent) => {
        const result = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: 'session-fixture',
          prompt: [],
        })
        expect(result.stopReason).toBe('end_turn')
        expect(received).toEqual([])
        expect(errorLog).toHaveBeenCalled()
        expect(() => expectAllNotifications(received, [malformed as unknown as acp.SessionNotification])).toThrow()
      })
    } finally {
      errorLog.mockRestore()
    }
  })

  it('keeps MCP environment fresh on load and omits client filesystem/terminal capabilities', () => {
    const servers = transcript
      .filter(({ message }) => message.method === 'session/new' || message.method === 'session/load')
      .map(({ message }) => (message.params as acp.NewSessionRequest).mcpServers[0])
    expect(servers).toHaveLength(2)
    expect(servers[0]).toMatchObject({ env: [{ name: 'KOBO_PROBE_TOKEN', value: 'first-launch' }] })
    expect(servers[1]).toMatchObject({ env: [{ name: 'KOBO_PROBE_TOKEN', value: 'second-launch' }] })
    for (const { message } of transcript.filter(({ message }) => message.method === 'initialize')) {
      const params = message.params as acp.InitializeRequest
      expect(params.clientCapabilities?.fs).toBeUndefined()
      expect(params.clientCapabilities?.terminal).toBeUndefined()
    }
    expect(transcript.every((record) => record.provenance === 'runtime-3.0.1')).toBe(true)
  })
})
