import { describe, expect, it } from 'vitest'
import { createOtherResponses } from '../utils/question-other-responses'

describe('createOtherResponses', () => {
  it('keeps a distinct free-form value for each question', () => {
    const responses = createOtherResponses(['scope', 'environment'])
    responses.scope = 'une tâche ciblée'
    responses.environment = 'un iPhone physique'

    expect(responses).toEqual({ scope: 'une tâche ciblée', environment: 'un iPhone physique' })
  })
})
