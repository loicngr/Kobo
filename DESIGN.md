# Design System — Kōbō

## Product Context

- **What this is:** Kōbō — a Claude Code multi-agent orchestrator. Each "workspace" is a
  self-contained mission with its own git worktree, branch, agent session, optional dev
  server, optional Notion source-of-truth, and a dedicated MCP tools server.
- **Who it's for:** Solo developer (the maintainer) + a small community of power-users
  distributed via `npx @loicngr/kobo`.
- **Space/industry:** Developer tools. Peers: Linear, Anthropic Console, Tailscale admin,
  Vercel dashboard. Not Notion, not Raycast, not Stripe marketing.
- **Project type:** Internal dev tool / SPA. Dark-native, dense, ≥10 interconnected panels.

## Memorable Thing

If a choice makes the product feel "fun" or
"chaleureux," it's wrong. If it makes the product feel "serious tool for serious work,"
it's right.

## Aesthetic Direction

- **Direction:** Brutally Minimal × Industrial
- **Decoration level:** minimal — typography + whitespace do the work
- **Mood:** Modern, monochrome, dense-but-aerated. Confident enough to use a single
  accent color sparingly. No gradients, no glow, no decorative blobs, no illustrations.
- **Reference sites:** Linear settings, Anthropic Console preferences, Tailscale admin,
  Vercel dashboard settings.

## Typography

Single typeface family for the entire UI. **Geist** (Vercel) — the modern de-facto
standard for dev tools. Tabular-nums included. Pair with **Geist Mono** for technical
values (paths, UUIDs, hex codes, branch names, model identifiers).

- **Display / Section headers:** Geist 600, 24px (`H2` / section titles)
- **Subsection headers:** Geist 600, 16px (`H3`)
- **Body / labels:** Geist 500, 14px
- **Secondary text / hints:** Geist 400, 13px, color `text-secondary`
- **Mono (paths, hex, IDs, branches, models):** Geist Mono 400, 13px, slight
  `bg-surface-2` background pill, color `text-secondary`
- **Loading:** Self-host from Vercel's CDN, or vendor the woff2 files into
  `src/client/public/fonts/`. Avoid Google Fonts for licensing clarity.

**Never use:** Inter, Roboto, Arial, system-ui, Open Sans, Poppins, Space Grotesk
(convergence trap), Lato. They scream "I gave up on typography."

## Color

Dark-first. The default state of Kōbō is the dark theme — light mode is a secondary
concern (or deliberately absent for now).

Palette aligned with Kobo's existing brand (deep purple-blue darks), refined
for accessibility. Variant C's cool-gray palette was rejected to keep cohesion
with the workspaces drawer and activity feed (which use the purple-blue tones).

```
Canvas / surfaces
  --kobo-bg            #1a1a2e    /* main canvas — matches workspace drawer body */
  --kobo-bg-deep       #16162a    /* deepest surface — sidebar nav */
  --kobo-surface       #222244    /* cards, panels */
  --kobo-surface-2     #1a1a30    /* inputs, popovers */
  --kobo-hover         #2a2a4a    /* hover on items in lists */

Borders
  --kobo-border-subtle #2a2a4a    /* internal section dividers */
  --kobo-border        #3a3a5e    /* card outlines, input borders */
  --kobo-border-strong #4a4a6e    /* focus ring (combined with accent) */

Text
  --kobo-text          #f4f4f5    /* primary */
  --kobo-text-2        #c9c9e8    /* secondary — most labels */
  --kobo-text-3        #9a9ab5    /* tertiary — hints, captions */
  --kobo-text-disabled #5a5a7a

Accent (rare, indigo — only for active states, primary CTAs, focus ring)
  --kobo-accent        #6c63ff    /* Kobo brand indigo */
  --kobo-accent-hover  #5a51e6
  --kobo-accent-fg     #ffffff

Semantic (used only when conveying status — keep desaturated)
  --kobo-success       #34d399
  --kobo-warning       #fbbf24
  --kobo-danger        #f87171
  --kobo-info          --kobo-accent
```

**Rules of color use:**

1. The accent (`--kobo-accent`) appears at most twice per visible screen — typically:
   the active sidebar item (left-border 2px) and the primary CTA. Never for decoration.
2. Semantic colors only carry meaning. A red border is a problem, not a style.
3. No gradients anywhere. Solid fills only. No glow, no shadow halos.
4. Hover states are a 1-shade nudge (`--kobo-hover`), not a saturation pump.

## Spacing

Base unit **4px**. Compact-aerated density (Linear, not Notion).

```
2xs   2px
xs    4px
sm    8px
md    12px
lg    16px
xl    20px   /* default card padding */
2xl   24px
3xl   32px   /* between sections */
4xl   48px
```

- Section padding: 20px
- Row gap (between settings within a section): 16px
- Section gap (between section headers): 32px
- Card padding: 20px (when cards are used at all)
- No element gets more padding than necessary to feel breathable

## Layout

- **Approach:** Sidebar split.
- **Sidebar:** 240px fixed width, dark `--kobo-surface`, 9 items rendered as
  `icon (16px Lucide) + label`. Active item: `border-left: 2px solid var(--kobo-accent)`,
  text in `--kobo-text`, slight background `--kobo-hover`. Inactive: `--kobo-text-2`,
  no border, hover bg `--kobo-hover`.
- **Content panel:** max-width 720px, left-aligned. Sections rendered **flat** (not
  cards): only `--kobo-border-subtle` dividers between rows. Section header on top,
  rows below, no encompassing card.
- **Top bar:** 48px tall, contains breadcrumb-style title left + `⌘K` shortcut hint
  right (muted).
- **Sticky save bar (when dirty):** full width, `bg-canvas` with `border-top
  --kobo-border-subtle`, contains "Unsaved changes" text left + primary `Save`
  button right. Slides up in 150ms when dirty, slides down when saved.
- **Border radius scale:** `sm 4px` (inputs, small buttons), `md 6px` (cards, larger
  buttons), `lg 8px` (modals). **No `9999px` pill shapes** — pills feel friendly,
  Kobo is not friendly, Kobo is precise.

## Motion

**Minimal-functional only.** This is non-negotiable — a dev tool must feel
instantaneous, not choreographed.

- **Easing:** Hover/focus `ease-out`, dismissals `ease-in`, movements `ease-in-out`
- **Duration:**
  - Micro (focus ring, hover): 100ms
  - Short (toggle, popover open): 150ms
  - Medium (sticky save bar slide-up): 200ms
  - Anything longer (or stagger, scroll-driven, entrance animations) is forbidden
- No spring physics. No bouncing. No `requestAnimationFrame` chains for cosmetic
  effects. Reserve animation for **state transitions that carry information**.

## Iconography

- **Library:** [Lucide icons](https://lucide.dev) exclusively. Cohérent with Geist.
- **Size:** 16px in nav, 14px inline, 12px in dense tables
- **Stroke:** 1.5px (default Lucide)
- **Color:** `--kobo-text-2` by default, `--kobo-text` on hover/active, `--kobo-accent`
  only when the icon carries the active-state meaning
- No emojis as decoration. Emojis are allowed only as user-content (workspace icons,
  templates), never in chrome.

## Component Patterns

- **Inputs:** Flat. `bg-surface-2`, `border-subtle`, focus → `border-accent` +
  2px accent-tinted shadow. No bevels.
- **Buttons:**
  - Primary: `bg-accent`, `text-accent-fg`, hover `bg-accent-hover`. One per screen
    (the page's main action — typically Save).
  - Secondary: `bg-surface-2`, `text`, `border-subtle`. Used for actions like
    "Refresh", "Reset to default".
  - Tertiary / link: no background, accent-colored text, underline on hover.
- **Toggles:** Quasar's `q-toggle` default, color override to `--kobo-accent`.
- **Segmented control / radio row:** Active option `bg-accent + text-accent-fg`,
  inactive `text-2` with hover bg `--kobo-hover`.
- **Mono pills:** Technical values get a 2px-padded mono pill with `bg-surface-2`
  background. Example: model IDs, UUIDs, paths, hex codes, branch names.

## Anti-Patterns (forbidden)

- Purple/violet gradients
- 3-column icon-in-circle feature grids
- Centered everything with uniform padding
- Bubble/pill shapes (`border-radius: 9999px`) on rectangular elements
- Multiple competing accent colors
- Drop-shadow halos on cards
- `system-ui` or `-apple-system` as primary display/body font
- Decorative SVG illustrations in section headers
- "Welcome back!" / "Let's get started!" tone in microcopy

## Settings-Page-Specific Application

The current `SettingsPage.vue` (~2400 lines, 3 tabs Général/Projets/Modèles, ~12 stacked
sub-cards within Général) should be redesigned to:

1. **Replace the 3-tab strip with a 240px left sidebar** listing every section:
   General, Models, Skills, Permissions, Notion, Sentry, Voice, Templates, Notifications,
   Worktrees, Projects, Export. Active section gets the accent left-border.
2. **Render only the active section** in the right panel. The current monolithic scroll
   is the root cause of "moche / pas pro".
3. **Replace nested `.settings-subcard` with flat rows** separated by 1px
   `border-subtle`. Section header at top, rows below, no card chrome.
4. **Move the floating "Enregistrer" button into a sticky save bar** that only appears
   when the form is dirty.
5. **Move technical values** (paths, UUIDs, hex codes, branch names) into mono pills.
6. **Default everything to the CSS variables below** — never hardcode `#1a1a2e`,
   never use Quasar's default indigo, never use raw `text-grey-5/6/7`.

## CSS Variables

These are the source of truth. Define them once in a global stylesheet, reference
them everywhere. Quasar component theming overrides go through these.

```scss
:root {
  --kobo-bg: #1a1a2e;
  --kobo-bg-deep: #16162a;
  --kobo-surface: #222244;
  --kobo-surface-2: #1a1a30;
  --kobo-hover: #2a2a4a;

  --kobo-border-subtle: #2a2a4a;
  --kobo-border: #3a3a5e;
  --kobo-border-strong: #4a4a6e;

  --kobo-text: #f4f4f5;
  --kobo-text-2: #c9c9e8;
  --kobo-text-3: #9a9ab5;
  --kobo-text-disabled: #5a5a7a;

  --kobo-accent: #6c63ff;
  --kobo-accent-hover: #5a51e6;
  --kobo-accent-fg: #ffffff;

  --kobo-success: #34d399;
  --kobo-warning: #fbbf24;
  --kobo-danger: #f87171;

  --kobo-radius-sm: 4px;
  --kobo-radius-md: 6px;
  --kobo-radius-lg: 8px;

  --kobo-space-2xs: 2px;
  --kobo-space-xs: 4px;
  --kobo-space-sm: 8px;
  --kobo-space-md: 12px;
  --kobo-space-lg: 16px;
  --kobo-space-xl: 20px;
  --kobo-space-2xl: 24px;
  --kobo-space-3xl: 32px;
  --kobo-space-4xl: 48px;

  --kobo-duration-micro: 100ms;
  --kobo-duration-short: 150ms;
  --kobo-duration-medium: 200ms;
}
```