import { describe, expect, it } from 'vitest'
import { parseBlocks, parseNotionUrl } from '../server/services/notion-service.js'

// ---------------------------------------------------------------------------
// parseNotionUrl
// ---------------------------------------------------------------------------

describe('parseNotionUrl(url)', () => {
  it("extrait l'ID depuis une URL avec titre et 32 hex sans tirets", () => {
    const url = 'https://www.notion.so/myworkspace/My-Page-Title-0123456789abcdef0123456789abcdef'
    const result = parseNotionUrl(url)
    expect(result).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it("extrait l'ID depuis une URL sans titre (32 hex directs)", () => {
    const url = 'https://www.notion.so/0123456789abcdef0123456789abcdef'
    const result = parseNotionUrl(url)
    expect(result).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it("extrait l'ID depuis une URL sans workspace", () => {
    const url = 'https://www.notion.so/0123456789abcdef0123456789abcdef'
    const result = parseNotionUrl(url)
    expect(result).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it("retourne l'UUID tel quel si déjà formaté avec tirets", () => {
    const url = 'https://www.notion.so/01234567-89ab-cdef-0123-456789abcdef'
    const result = parseNotionUrl(url)
    expect(result).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it('ignore les paramètres de requête (?v=...)', () => {
    const url = 'https://www.notion.so/0123456789abcdef0123456789abcdef?v=some_view_id'
    const result = parseNotionUrl(url)
    expect(result).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it('ignore les fragments (#section)', () => {
    const url = 'https://www.notion.so/0123456789abcdef0123456789abcdef#some-section'
    const result = parseNotionUrl(url)
    expect(result).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it("gère les lettres majuscules dans l'ID", () => {
    const url = 'https://www.notion.so/ABCDEF1234567890ABCDEF1234567890'
    const result = parseNotionUrl(url)
    expect(result).toBe('ABCDEF12-3456-7890-ABCD-EF1234567890')
  })

  it("lève une erreur si l'URL ne contient pas d'ID valide", () => {
    expect(() => parseNotionUrl('https://www.notion.so/')).toThrow(/Could not extract page ID from Notion URL/)
    expect(() => parseNotionUrl('https://example.com/not-a-notion-url')).toThrow(
      /Could not extract page ID from Notion URL/,
    )
  })

  it('retourne un UUID au format 8-4-4-4-12', () => {
    const url = 'https://www.notion.so/ffffffffffffffffffffffffffffffff'
    const result = parseNotionUrl(url)
    expect(result).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  })
})

// ---------------------------------------------------------------------------
// parseBlocks – helpers
// ---------------------------------------------------------------------------

function makeHeading(level: 1 | 2 | 3, text: string) {
  const type = `heading_${level}` as const
  return {
    type,
    [type]: { rich_text: [{ plain_text: text }] },
  }
}

function makeParagraph(text: string) {
  return {
    type: 'paragraph',
    paragraph: { rich_text: [{ plain_text: text }] },
  }
}

function makeTodo(text: string, checked: boolean) {
  return {
    type: 'to_do',
    to_do: { rich_text: [{ plain_text: text }], checked },
  }
}

function makeCode(text: string, language = 'gherkin') {
  return {
    type: 'code',
    code: { rich_text: [{ plain_text: text }], language },
  }
}

function makeBullet(text: string) {
  return {
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ plain_text: text }] },
  }
}

// ---------------------------------------------------------------------------
// parseBlocks – tests
// ---------------------------------------------------------------------------

describe('parseBlocks() — objectif / goal', () => {
  it('extrait le goal depuis une section "Objectif"', () => {
    const blocks = [makeHeading(2, 'Objectif'), makeParagraph('Permettre aux utilisateurs de se connecter.')]
    const { goal } = parseBlocks(blocks)
    expect(goal).toBe('Permettre aux utilisateurs de se connecter.')
  })

  it('extrait le goal depuis une section "Goal" (anglais)', () => {
    const blocks = [makeHeading(1, 'Goal'), makeParagraph('Allow users to sign in.')]
    const { goal } = parseBlocks(blocks)
    expect(goal).toBe('Allow users to sign in.')
  })

  it('concatène les paragraphes multiples dans la section objectif', () => {
    const blocks = [makeHeading(2, 'Objectif'), makeParagraph('Ligne 1.'), makeParagraph('Ligne 2.')]
    const { goal } = parseBlocks(blocks)
    expect(goal).toBe('Ligne 1.\nLigne 2.')
  })

  it('ne capture pas les paragraphes hors de la section objectif', () => {
    const blocks = [
      makeParagraph('Avant objectif.'),
      makeHeading(2, 'Objectif'),
      makeParagraph('Dans objectif.'),
      makeHeading(2, 'Autre section'),
      makeParagraph('Après objectif.'),
    ]
    const { goal } = parseBlocks(blocks)
    expect(goal).toBe('Dans objectif.')
  })
})

describe('parseBlocks() — todos', () => {
  it('extrait les todos (checked et unchecked)', () => {
    const blocks = [makeTodo('Écrire les tests', false), makeTodo('Déployer en prod', true)]
    const { todos } = parseBlocks(blocks)
    expect(todos).toHaveLength(2)
    expect(todos[0]).toEqual({ title: 'Écrire les tests', checked: false })
    expect(todos[1]).toEqual({ title: 'Déployer en prod', checked: true })
  })

  it('retourne un tableau vide si aucun todo', () => {
    const blocks = [makeParagraph('Simple texte')]
    const { todos } = parseBlocks(blocks)
    expect(todos).toHaveLength(0)
  })
})

describe('parseBlocks() — Gherkin (paragraphes)', () => {
  it('détecte les blocs Gherkin en anglais', () => {
    const blocks = [
      makeParagraph('Feature: Login'),
      makeParagraph('Scenario: Successful login'),
      makeParagraph('Given a user exists'),
      makeParagraph('When they enter credentials'),
      makeParagraph('Then they are logged in'),
    ]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(1)
    expect(gherkinFeatures[0]).toContain('Feature: Login')
    expect(gherkinFeatures[0]).toContain('Then they are logged in')
  })

  it('détecte les blocs Gherkin en français (Scénario, Étant donné)', () => {
    const blocks = [
      makeParagraph('Fonctionnalité: Connexion'),
      makeParagraph('Scénario: Connexion réussie'),
      makeParagraph('Étant donné un utilisateur existant'),
      makeParagraph('Quand il saisit ses identifiants'),
      makeParagraph('Alors il est connecté'),
    ]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(1)
    expect(gherkinFeatures[0]).toContain('Fonctionnalité: Connexion')
    expect(gherkinFeatures[0]).toContain('Alors il est connecté')
  })

  it('sépare les blocs Gherkin sur les headings', () => {
    const blocks = [
      makeParagraph('Scenario: First'),
      makeParagraph('Given something'),
      makeHeading(2, 'Une section'),
      makeParagraph('Scenario: Second'),
      makeParagraph('Given another thing'),
    ]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(2)
    expect(gherkinFeatures[0]).toContain('Scenario: First')
    expect(gherkinFeatures[1]).toContain('Scenario: Second')
  })

  it('sépare les Scénarios numérotés en paragraphes + steps en bullets (format Notion)', () => {
    // Reproduit le format Image #57: "Scénario 1 :" en paragraphe, steps en bullets
    const blocks = [
      makeParagraph('Scénario 1 : Avoir avec référence facture'),
      makeBullet("Étant donné un avoir (BT-3 = 381) créé à partir d'une facture existante"),
      makeBullet('Quand le document est généré'),
      makeBullet("Alors BT-25 contient le numéro de la facture d'origine"),
      makeParagraph('Scénario 2 : Type de facture antérieure'),
      makeBullet('Étant donné un avoir de type 381 avec une référence antérieure'),
      makeBullet('Quand le document est exporté'),
      makeBullet('Alors EXT-FR-FE-02 indique le type du document référencé'),
    ]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(2)
    expect(gherkinFeatures[0]).toContain('Scénario 1 : Avoir avec référence facture')
    expect(gherkinFeatures[0]).toContain('BT-25 contient')
    expect(gherkinFeatures[0]).not.toContain('Scénario 2')
    expect(gherkinFeatures[1]).toContain('Scénario 2 : Type de facture antérieure')
    expect(gherkinFeatures[1]).toContain('EXT-FR-FE-02')
  })

  it('sépare plusieurs Scenario consécutifs sans heading entre eux', () => {
    const blocks = [
      makeParagraph('Scenario: First'),
      makeParagraph('Given something'),
      makeParagraph('Then it works'),
      makeParagraph('Scenario: Second'),
      makeParagraph('Given another'),
      makeParagraph('Then it also works'),
      makeParagraph('Scénario: Troisième'),
      makeParagraph('Étant donné une chose'),
      makeParagraph('Alors une autre'),
    ]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(3)
    expect(gherkinFeatures[0]).toContain('Scenario: First')
    expect(gherkinFeatures[0]).not.toContain('Scenario: Second')
    expect(gherkinFeatures[1]).toContain('Scenario: Second')
    expect(gherkinFeatures[2]).toContain('Scénario: Troisième')
  })
})

describe('parseBlocks() — Gherkin (blocs de code)', () => {
  it('extrait un bloc Gherkin depuis un bloc de code', () => {
    const gherkinText = 'Feature: API\nScenario: GET /users\nGiven the API is running\nThen return 200'
    const blocks = [makeCode(gherkinText)]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(1)
    expect(gherkinFeatures[0]).toBe(gherkinText)
  })

  it('ignore un bloc de code sans Gherkin', () => {
    const blocks = [makeCode('const x = 1\nconsole.log(x)', 'javascript')]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(0)
  })

  it('sépare plusieurs Scenario dans un même bloc de code', () => {
    const gherkinText = [
      'Scenario: Nominal — A',
      '  Given a thing',
      '  Then it works',
      '',
      'Scenario: Nominal — B',
      '  Given another thing',
      '  Then it also works',
      '',
      'Scénario: Cas FR',
      '  Étant donné une chose',
      '  Alors ça marche',
    ].join('\n')
    const blocks = [makeCode(gherkinText)]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(3)
    expect(gherkinFeatures[0]).toContain('Scenario: Nominal — A')
    expect(gherkinFeatures[0]).not.toContain('Scenario: Nominal — B')
    expect(gherkinFeatures[1]).toContain('Scenario: Nominal — B')
    expect(gherkinFeatures[2]).toContain('Scénario: Cas FR')
  })

  it('garde "Feature:" attaché au premier Scenario dans un bloc de code', () => {
    const gherkinText = ['Feature: Login', 'Scenario: OK', '  Given a user', '  Then welcome'].join('\n')
    const blocks = [makeCode(gherkinText)]
    const { gherkinFeatures } = parseBlocks(blocks)
    expect(gherkinFeatures).toHaveLength(1)
    expect(gherkinFeatures[0]).toContain('Feature: Login')
    expect(gherkinFeatures[0]).toContain('Scenario: OK')
  })
})

describe('parseBlocks() — cas limites', () => {
  it('retourne des valeurs vides sur un tableau de blocs vide', () => {
    const result = parseBlocks([])
    expect(result.goal).toBe('')
    expect(result.todos).toHaveLength(0)
    expect(result.gherkinFeatures).toHaveLength(0)
  })

  it("ne confond pas un todo avec l'objectif", () => {
    const blocks = [
      makeHeading(2, 'Objectif'),
      makeTodo('Tâche dans objectif', false),
      makeParagraph('Texte après todo'),
    ]
    // A todo_do block resets insideObjectif, so the paragraph after it is NOT goal
    const { goal, todos } = parseBlocks(blocks)
    expect(todos).toHaveLength(1)
    expect(goal).toBe('')
  })
})
