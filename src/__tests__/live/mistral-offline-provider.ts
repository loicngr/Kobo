import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'

type Message = { role: string; content?: unknown }
export async function createOfflineVibeProvider(directory: string) {
  const markers: string[] = []
  const readResults: Record<string, string> = {}
  const answers: Record<string, string> = {}
  const job = join(directory, 'job.mjs')
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Message[] }
    const userIndex = body.messages.map((message) => message.role).lastIndexOf('user')
    const prompt = JSON.stringify(body.messages[userIndex]?.content)
    const stopping = prompt.includes('STOP_PROBE')
    const resumed = prompt.includes('RESUME_PROBE')
    const reviewing = prompt.includes('REVIEW_PROBE')
    const short = prompt.includes('MODE_PROBE') || reviewing
    const turn = resumed ? 'resume' : 'first'
    const results = body.messages.slice(userIndex + 1).filter((message) => message.role === 'tool')
    const resultText = JSON.stringify(results)
    for (const marker of ['first-launch', 'second-launch', 'strict-launch', 'bypass-launch'])
      if (resultText.includes(marker) && !markers.includes(marker)) markers.push(marker)
    const steps: [string, Record<string, unknown>][] = reviewing
      ? []
      : [
          ['search_tool_functions', { query: 'mcp_kobo_probe.env_probe' }],
          ['run_typescript', { code: 'async function main(){return await tools.mcp_kobo_probe.env_probe({});}' }],
        ]
    if (reviewing) steps.push(['write_file', { path: join(directory, 'review-denied.txt'), content: 'must not exist' }])
    if (!short && !stopping)
      steps.push(
        ['write_file', { path: join(directory, `${turn}-denied.txt`), content: 'must not exist' }],
        ['write_file', { path: join(directory, `${turn}-allowed.txt`), content: 'native-file' }],
        ['read_file', { path: join(directory, `${turn}-allowed.txt`) }],
      )
    if (stopping)
      steps.push([
        'run_typescript',
        {
          code: `async function main(){return await tools.process.start({command:${JSON.stringify(`exec ${shellQuote(process.execPath)} ${shellQuote(job)}`)}});}`,
        },
      ])
    if (!short)
      steps.push([
        'ask_user_question',
        { questions: [{ question: 'Choose the offline check', options: [{ label: 'One' }, { label: 'Two' }] }] },
      ])
    const read = results[steps.findIndex(([name]) => name === 'read_file')]
    const answer = results[steps.findIndex(([name]) => name === 'ask_user_question')]
    if (read) readResults[turn] = JSON.stringify(read.content)
    if (answer) answers[turn] = JSON.stringify(answer.content)
    const step = steps[results.length]
    const delta = step
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `probe-${turn}-${results.length}`,
              type: 'function',
              function: { name: step[0], arguments: JSON.stringify(step[1]) },
            },
          ],
        }
      : { role: 'assistant', content: `ADAPTER_${turn.toUpperCase()}_COMPLETE` }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const chunk of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ])
      response.write(
        `data: ${JSON.stringify({ id: 'offline-adapter', object: 'chat.completion.chunk', model: 'probe', ...chunk })}\n\n`,
      )
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback provider address')
  return {
    markers,
    readResults,
    answers,
    url: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
