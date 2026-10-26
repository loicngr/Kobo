import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const scenario = process.argv[2] ?? 'normal'
let finishPrompt
let descendant
if (scenario === 'descendant') {
  descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}
const connection = acp.agent({ name: 'offline-vibe-peer' })
  .onRequest(acp.methods.agent.initialize, async () => {
    if (scenario === 'initialize-pending') await new Promise(() => {})
    if (scenario === 'invalid-initialize') return { protocolVersion: 99 }
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }
  })
  .onRequest(acp.methods.agent.session.new, async () => {
    if (scenario === 'setup-pending') await new Promise(() => {})
    if (scenario === 'invalid-session') return { sessionId: '' }
    return { sessionId: 'fixture-session' }
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } },
    })
    return {}
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (scenario === 'eof') { process.exit(0) }
    if (scenario === 'pending') return new Promise((resolve) => { finishPrompt = resolve })
    if (scenario === 'malformed') process.stdout.write('{invalid json}\n')
    if (scenario === 'invalid-update') {
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'unknown' } })
    }
    if (scenario === 'callbacks') {
      const permission = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId, toolCall: { toolCallId: 'tool-1' },
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      })
      const question = await client.request(acp.methods.client.elicitation.create, {
        sessionId: params.sessionId, mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: { q0: { type: 'string' } } },
      })
      if (permission.outcome.optionId !== 'allow_once' || question.content?.q0 !== 'answer') throw new Error('Wrong callback result')
    }
    return { stopReason: scenario === 'invalid-prompt' ? 'unknown' : 'end_turn' }
  })
  .onNotification(acp.methods.agent.session.cancel, () => { finishPrompt?.({ stopReason: 'cancelled' }) })
  .onRequest(acp.methods.agent.session.close, async () => {
    if (scenario === 'close-pending') await new Promise(() => {})
    return {}
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))

process.stderr.write(`READY ${process.cwd()} ${process.env.KOBO_FAKE_MARKER ?? ''}\n`)
if (scenario === 'stderr') process.stderr.write(`secret-token-${'x'.repeat(10000)}\n`)
if (scenario === 'ignore-eof') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
await connection.closed
if (descendant) {
  // Deliberately leave an in-group child so ownership tests can observe it.
  process.exit(0)
}
