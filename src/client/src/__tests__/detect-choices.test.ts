import { describe, expect, it } from 'vitest'
import { detectChoices } from '../utils/detect-choices'

describe('detectChoices', () => {
  it('detects A/B/C/D bold choices preceded by a question', () => {
    const text = `Quel format préfères-tu pour la date/heure ?

- **A.** Date + heure sur une seule ligne — ex. \`27 avr. 2026, 14:32:05\`
- **B.** Date sur une ligne, heure sur la ligne en dessous (plus lisible, prend 2 lignes)
- **C.** Heure uniquement (avec date au survol/tooltip)
- **D.** Autre (précise)`
    const out = detectChoices(text)
    expect(out).not.toBeNull()
    expect(out?.choices).toEqual([
      { key: 'A', label: 'Date + heure sur une seule ligne — ex. `27 avr. 2026, 14:32:05`' },
      { key: 'B', label: 'Date sur une ligne, heure sur la ligne en dessous (plus lisible, prend 2 lignes)' },
      { key: 'C', label: 'Heure uniquement (avec date au survol/tooltip)' },
      { key: 'D', label: 'Autre (précise)' },
    ])
  })

  it('detects numeric 1/2/3 choices preceded by a question', () => {
    // Use the same `- **X.** label` shape as letter choices so the key
    // is always the bold prefix, never the bullet number.
    const text = `Combien de threads veux-tu ?

- **1.** single-thread
- **2.** quad
- **3.** octa`
    const out = detectChoices(text)
    expect(out?.choices).toEqual([
      { key: '1', label: 'single-thread' },
      { key: '2', label: 'quad' },
      { key: '3', label: 'octa' },
    ])
  })

  it('returns null when there is no question mark before the list', () => {
    // Defensive: a bare numbered list ("1. faire X 2. faire Y") shouldn't
    // produce buttons — those aren't choices, they're a plan.
    const text = `Voici le plan :

1. Faire X
2. Faire Y
3. Faire Z`
    expect(detectChoices(text)).toBeNull()
  })

  it('returns null when there is only one item (not a real choice)', () => {
    const text = `Question ?

- **A.** Seul item`
    expect(detectChoices(text)).toBeNull()
  })

  it('returns null when content has no list at all', () => {
    expect(detectChoices('Une simple phrase sans liste ?')).toBeNull()
  })

  it('detects choices even when the question is several lines above the list', () => {
    // Tolerant: the agent often interleaves context between the question and
    // the choices. As long as a `?` appears reasonably close before the list,
    // we accept.
    const text = `Quel format ?
Voici ce que je propose, à toi de choisir.

- **A.** Format ISO
- **B.** Format français`
    const out = detectChoices(text)
    expect(out).not.toBeNull()
    expect(out?.choices.map((c) => c.key)).toEqual(['A', 'B'])
  })

  it('only detects the FIRST group when multiple question/choice blocks coexist', () => {
    // Multi-question messages are common in brainstorming. Parsing the first
    // group keeps the UI predictable; the user clicks A, the agent replies
    // and the second group surfaces in the next message.
    const text = `Question 1 ?

- **A.** un
- **B.** deux

Question 2 ?

- **A.** trois
- **B.** quatre`
    const out = detectChoices(text)
    expect(out?.choices.map((c) => c.label)).toEqual(['un', 'deux'])
  })

  it('strips the leading bullet and bold markers from labels', () => {
    const text = `Quoi ?

- **A.** plain text
- **B.** *italic stays*
* **C.** asterisk bullet works too`
    const out = detectChoices(text)
    expect(out?.choices).toEqual([
      { key: 'A', label: 'plain text' },
      { key: 'B', label: '*italic stays*' },
      { key: 'C', label: 'asterisk bullet works too' },
    ])
  })

  it('returns choices in the order they appear', () => {
    const text = `Lequel ?

- **C.** trois
- **A.** un
- **B.** deux`
    const out = detectChoices(text)
    // The agent is the source of truth for ordering — we don't sort.
    expect(out?.choices.map((c) => c.key)).toEqual(['C', 'A', 'B'])
  })

  it('detects un-bolded lettered choices (the agent often forgets the ** markers)', () => {
    // Real-world example from a brainstorm session — Claude wrote the choices
    // without the ** bold prefix the prompt template suggests.
    const text = `Quelle couleur de thème préfères-tu pour le footer date/heure ?

- A. Gris discret (\`text-grey-5\`)
- B. Indigo accentué (\`text-indigo-4\`)
- C. Blanc cassé (\`text-grey-3\`)`
    const out = detectChoices(text)
    expect(out?.choices).toEqual([
      { key: 'A', label: 'Gris discret (`text-grey-5`)' },
      { key: 'B', label: 'Indigo accentué (`text-indigo-4`)' },
      { key: 'C', label: 'Blanc cassé (`text-grey-3`)' },
    ])
  })

  it('does NOT treat a plain numeric bulleted list as choices (avoids false positives on plans)', () => {
    // `- 1. faire X` looks superficially like a choice but in practice the
    // agent uses unbolded numbers for plan steps, not multiple-choice. Bold
    // numeric keys (`- **1.** …`) remain detected.
    const text = `Voici les étapes prévues — d'accord ?

- 1. Lire le fichier
- 2. Modifier le composant
- 3. Lancer les tests`
    expect(detectChoices(text)).toBeNull()
  })
})
