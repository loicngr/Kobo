import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'
import { useSettingsStore } from '../stores/settings'
import { createTour } from '../tours/create'
import { gitPrTour } from '../tours/git-pr'
import { homeTour } from '../tours/home'
import { TOURS } from '../tours/registry'
import { SETTINGS_GROUPS } from '../tours/settings'
import { workspaceTour } from '../tours/workspace'

const LOCALES: Record<string, Record<string, string>> = { en, fr, de, es, it: itLocale }

function walkVue(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkVue(full, out)
    else if (full.endsWith('.vue')) out.push(full)
  }
  return out
}

/** The `<template>` blocks of every Vue source, HTML comments stripped, so a commented-out anchor does not count. */
function templateSources(): string {
  return walkVue(join(__dirname, '..'))
    .map((f) => readFileSync(f, 'utf-8'))
    .flatMap((src) => [...src.matchAll(/<template[^>]*>([\s\S]*?)\n<\/template>/g)].map((m) => m[1] as string))
    .map((tpl) => tpl.replace(/<!--[\s\S]*?-->/g, ''))
    .join('\n')
}

/** Tab ids of the Settings page, read from `navItems` in `SettingsPage.vue`. */
function settingsNavTabs(): string[] {
  const settingsSource = readFileSync(join(__dirname, '../pages/SettingsPage.vue'), 'utf-8')
  const navStart = settingsSource.indexOf('const navItems')
  expect(navStart, 'const navItems not found in SettingsPage.vue').toBeGreaterThanOrEqual(0)
  const navBlock = settingsSource.slice(navStart, settingsSource.indexOf(']', navStart))
  return [...navBlock.matchAll(/value:\s*['"]([\w-]+)['"]/g)].map((m) => m[1] as string)
}

describe('tours registry', () => {
  it('has unique step ids and no empty tour', () => {
    const ids = TOURS.flatMap((t) => t.steps.map((s) => s.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(TOURS.length).toBe(9)
    for (const tour of TOURS) expect(tour.steps.length, tour.id).toBeGreaterThan(0)
  })

  it('has a title, and a title + description per step, in every locale', () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const tour of TOURS) {
        expect(dict[`${tour.i18nKey}.title`], `${locale}: ${tour.i18nKey}.title`).toBeTypeOf('string')
        for (const step of tour.steps) {
          expect(dict[`${step.i18nKey}.title`], `${locale}: ${step.i18nKey}.title`).toBeTypeOf('string')
          expect(dict[`${step.i18nKey}.description`], `${locale}: ${step.i18nKey}.description`).toBeTypeOf('string')
        }
      }
    }
  })

  it('gates the steps whose anchor is rendered conditionally, as DOM gates', () => {
    const gated = ['create-brainstorm', 'create-comparison', 'ws-selectors', 'ws-tab-subagents', 'pr-actions']
    const byId = new Map(TOURS.flatMap((t) => t.steps.map((s) => [s.id, s] as const)))
    for (const id of gated) {
      expect(byId.get(id)?.when, id).toBeTypeOf('function')
      expect(byId.get(id)?.gate, id).toBe('dom')
    }
  })

  it('anchors every step on a data-tour attribute rendered by a Vue template', () => {
    const sources = templateSources()
    // `SettingsNavList.vue` renders its nav anchors from a template literal, so
    // any `settings-nav-*` click target counts as present when that literal exists.
    const dynamicSettingsNav = /\s:data-tour="`settings-nav-\$\{item\.value\}`"/.test(sources)
    const hasAnchor = (anchor: string) =>
      new RegExp(`\\sdata-tour="${anchor}"`).test(sources) || (dynamicSettingsNav && anchor.startsWith('settings-nav-'))
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        expect(hasAnchor(step.anchor), `${tour.id}/${step.id} -> ${step.anchor}`).toBe(true)
        if (step.clickTarget) {
          expect(hasAnchor(step.clickTarget), `${tour.id}/${step.id} click -> ${step.clickTarget}`).toBe(true)
        }
      }
    }
  })

  it('only clicks settings-nav-* targets that name a real Settings tab', () => {
    const navTabs = settingsNavTabs()
    const targets = TOURS.flatMap((t) => t.steps.map((s) => s.clickTarget)).filter(
      (c): c is string => !!c && c.startsWith('settings-nav-'),
    )
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) expect(navTabs, target).toContain(target.slice('settings-nav-'.length))
  })
})

describe('create tour', () => {
  it('follows the form top to bottom, brainstorm last since it needs auto-loop on', () => {
    expect(createTour.steps.map((s) => s.id)).toEqual([
      'create-template',
      'create-mission',
      'create-project',
      'create-engine',
      'create-autoloop',
      'create-comparison',
      'create-brainstorm',
    ])
  })
})

describe('workspace tour', () => {
  it('visits the documents tab right after the (gated) sub-agents tab', () => {
    const ids = workspaceTour.steps.map((s) => s.id)
    expect(ids.indexOf('ws-tab-documents')).toBe(ids.indexOf('ws-tab-subagents') + 1)
    expect(workspaceTour.steps.find((s) => s.id === 'ws-tab-documents')?.clickTarget).toBe('ws-tabnav-documents')
  })
})

describe('git-pr tour', () => {
  it('ends on one workspace-list step, gated on an open PR like the panel step', () => {
    const ids = gitPrTour.steps.map((s) => s.id)
    expect(ids).toEqual(['pr-panel', 'pr-actions', 'pr-after'])
    const after = gitPrTour.steps[2]
    expect(after?.anchor).toBe('workspace-list')
    expect(after?.i18nKey).toBe('tours.gitPr.attention')
    expect(after?.when).toBeTypeOf('function')
    expect(after?.gate).not.toBe('dom')
  })
})

describe('home tour onDone', () => {
  const push = vi.fn(async (): Promise<unknown> => undefined)
  const currentRoute = { value: { name: 'workspace' as string, params: {} as Record<string, string> } }
  const router = { push, currentRoute } as unknown as Router

  beforeEach(() => {
    setActivePinia(createPinia())
    push.mockClear()
    currentRoute.value.params = {}
  })

  it('stays put when a workspace is already open', () => {
    useSettingsStore().projects = []
    currentRoute.value.params = { id: 'ws1' }
    homeTour.onDone?.(router)
    expect(push).not.toHaveBeenCalled()
  })

  it('goes to the settings when no project is configured', () => {
    useSettingsStore().projects = []
    homeTour.onDone?.(router)
    expect(push).toHaveBeenCalledWith({ name: 'settings' })
  })

  it('goes to the create form once a project exists', () => {
    useSettingsStore().projects = [{ path: '/p' } as never]
    homeTour.onDone?.(router)
    expect(push).toHaveBeenCalledWith({ name: 'create' })
  })
})

describe('settings tour groups', () => {
  const navTabs = settingsNavTabs()

  it('covers every Settings tab exactly once', () => {
    const grouped = Object.values(SETTINGS_GROUPS).flat()
    expect(navTabs.length).toBeGreaterThan(10)
    for (const tab of navTabs)
      expect(
        grouped.filter((g) => g === tab),
        tab,
      ).toHaveLength(1)
    for (const tab of grouped) expect(navTabs, tab).toContain(tab)
  })

  it('opens the misc group on the general tab and the engines group on the agents tab', () => {
    expect(SETTINGS_GROUPS.misc[0]).toBe('general')
    expect([...SETTINGS_GROUPS.engines]).toEqual(['agents'])
  })

  it('gives every Settings tab a help sentence in every locale', () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const tab of navTabs) expect(dict[`settings.help.${tab}`], `${locale}: ${tab}`).toBeTypeOf('string')
    }
  })
})
