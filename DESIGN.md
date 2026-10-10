---
name: Pontis
description: Cold Rational Workspace — the self-hosted bookmark sync surface that stays quiet when nothing is wrong.
colors:
  accent: "#3f62c0"
  accent-hover: "#2e4fa5"
  accent-quiet: "#f0f4ff"
  accent-focus: "#dce4f7"
  app-bg: "#f8f9fa"
  workspace-bg: "#ffffff"
  raised-bg: "#f1f3f5"
  subtle-border: "#e7e9ec"
  text-primary: "#111315"
  text-secondary: "#6b717a"
  text-disabled: "#9ca3af"
  sync-healthy: "#2f932f"
  sync-warning: "#e5a510"
  sync-recovery: "#cc5213"
  sync-error: "#c42a24"
  graphite-app: "#111315"
  graphite-workspace: "#17191c"
  graphite-raised: "#1d2024"
  graphite-border: "#2a2d31"
  graphite-text: "#e5e7eb"
  accent-dark: "#5e82d6"
typography:
  page-title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif'
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
  section-label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif'
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  content-primary:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.55
    color: "{colors.text-secondary}"
  measure:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
    fontSize: "12px"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  pill: "1000px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.workspace-bg}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "36px"
    typography:
      fontSize: "12px"
      fontWeight: 500
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.accent-quiet}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "0 18px"
    height: "36px"
  button-quiet:
    backgroundColor: "{colors.workspace-bg}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
  button-destructive:
    backgroundColor: "{colors.workspace-bg}"
    textColor: "{colors.sync-error}"
    rounded: "{rounded.sm}"
  section-card:
    backgroundColor: "{colors.workspace-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "12px"
  list-row:
    backgroundColor: "{colors.workspace-bg}"
    textColor: "{colors.text-primary}"
    padding: "12px 0"
  input:
    backgroundColor: "{colors.workspace-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  status-badge:
    backgroundColor: "{colors.raised-bg}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "18px"
---

# Design System: Pontis

## Overview

**Creative North Star: "Cold Rational Workspace / 冷灰理性工作台"**

Pontis looks like a well-made desktop tool that happens to run in a browser, not like an
admin panel and not like a content site. White and graphite gray carry the whole interface;
a single low-saturation cool blue is reserved for interaction and state, never for
decoration. Density is the point: small vertical rhythm, stable horizontal alignment, one
consistent row height, low-contrast borders, and a restrained type ladder let a user scan
hundreds of bookmarks, several devices and a long revision history without leaving the page.

The system's most deliberate property is that it goes quiet when things are fine. "Synced",
"healthy", "normal" recede into the background; only warning, recovery, conflict, failure
and a question that needs an answer are allowed to raise their visual weight. Emphasis is
earned by state, never by layout. Structure comes from 1px dividers, tonal surface steps,
spacing and typography — shadows appear only on layers that actually float.

Implemented today in two surfaces that share one theme: the React web console
(`web/src/theme/pontis-theme.ts`, `web/src/styles/semantic-tokens.css.ts`) and the browser
extension (`extension/src/theme/pontisTheme.ts` plus `pontisTheme.css`, which maps the
Graphite Dark palettes over Mantine's own variables). The normative source for every token
is the Mantine theme; no second token system exists. `[normative spec: docs/23]`

**Key Characteristics:**
- White + graphite + one muted cool blue; status color is the only other ink.
- Compact by default: 12–14px content type, 36px controls, 4–20px spacing ladder.
- Borders and tonal surfaces do the structural work; shadows are for floating layers only.
- Small radii (6px controls, 8px cards, 10px dialogs); no nested containers, no card grids.
- Dark mode is a first-class palette (Graphite Dark), not an inversion.
- Healthy state is deliberately unremarkable.

## Colors

The palette is a cool gray ladder with one blue accent and four low-saturation status inks;
nothing else is allowed to be colorful.

### Primary
- **Muted Cool Blue / accent** (`#3f62c0`, shade 6 of the accent ramp): the interactive
  voice — primary action, selected item, active filter, focus ring, link, and the "syncing"
  state. It is a *use-budget* color: one filled instance per view, plus small selection
  tints. `[measured: 立即同步 fill]`
- **Deep Cool Blue / accent-hover** (`#2e4fa5`): hover and pressed on accent surfaces.
- **Whisper Blue / accent-quiet** (`#f0f4ff`) and **Cool Blue Tint / accent-focus**
  (`#dce4f7`): selected and focus backgrounds. Selection is always a pale blue field with
  dark text — never a blue field with white text.

### Secondary
The system has no second brand color. Status inks below do the expressive work.

### Tertiary
None. A second accent would compete with the blue and is not part of this world.

### Neutral
- **Graphite Ink / text-primary** (`#111315`): body text and headings. Graphite, never pure
  black.
- **Slate Gray / text-secondary** (`#6b717a`): metadata, column headers, helper text.
- **Ash Gray / text-disabled** (`#9ca3af`): disabled and placeholder-adjacent text.
- **App Cool Gray / app-bg** (`#f8f9fa`): the page behind everything.
- **Workspace White / workspace-bg** (`#ffffff`): the working surface, cards, inputs.
- **Raised Cool Gray / raised-bg** (`#f1f3f5`): hover fills, inset wells, light badge fields.
- **Hairline Cool / subtle-border** (`#e7e9ec`): the token value for 1px structure. Mantine's
  own component defaults render one step darker (`#dee2e6`); both are in use, and the token
  is the one to cite in new work.

### Sync status inks
- **Signal Green / sync-healthy** (`#2f932f`): a binding that is active and caught up.
- **Soft Amber / sync-warning** (`#e5a510`): the server needs an answer from the user.
- **Recovery Orange / sync-recovery** (`#cc5213`): mount missing, history expired, or work
  still queued that the user should know about.
- **Soft Red / sync-error** (`#c42a24`): failure and destructive action.
- Offline and disabled stay neutral gray. Status is never carried by color alone.

### Graphite Dark
Dark mode swaps to a graphite ramp: app `#111315`, workspace `#17191c`, raised `#1d2024`,
border `#2a2d31`, primary text `#e5e7eb`, accent lifted to `#5e82d6`. No pure black, no
bright white body text, borders stay faint, selection is a deep blue-gray.

**The One Voice Rule.** Exactly one accent color per surface. If a second saturated hue
appears, one of them is wrong.

**The Quiet Green Rule.** Healthy is a 10%-tint badge with 12px text, not a banner. A
correctly syncing device should be almost boring to look at.

**The No-Blue-Field Rule.** Never invert to white-on-blue for selection, headers, sidebars
or hero areas. Blue is ink and hairline, not wallpaper.

## Typography

**Display / Page Font:** system stack — `-apple-system, BlinkMacSystemFont, "Segoe UI",
"Inter", sans-serif`
**Body Font:** same system stack; the product does not ship a webfont.
**Measure / Mono Font:** `ui-monospace, SFMono-Regular, Consolas, monospace`

**Character:** the ladder is short and shallow on purpose — 18px at the top, 10–14px below
it. Hierarchy is built from weight (400/500/600) and color step rather than size, so a
dense page still reads as an outline. The system face is a deliberate choice for native-tool
feel and cross-platform metrics.

### Hierarchy
- **Page title** (600, 18px, 1.4): one per screen, in the header band. `[measured: options h1]`
- **Section label** (600, 12px, uppercase, `text-secondary`-adjacent): a settings section or
  group heading. Uppercase affects Latin text only; CJK headings stay as written.
- **Content primary** (400, 14px): the name of a thing the user is working on — bookmark,
  folder, space.
- **Body** (400, 13px): descriptions, helper text, option labels. Paragraph measure capped
  around 64ch so a wide settings page never turns into a full-bleed ribbon.
- **Metadata** (500, 12px): column headers, timestamps, epoch and revision lines. Always
  secondary color, never bold-700.
- **Measure / mono** (400, 12px, `ui-monospace`): revision watermarks, UUIDs, binding and
  session ids, error codes. Numeric watermarks additionally get `tabular-nums` so columns
  of `4 / 4` and `118 / 118` align.
- **Status label** (700, 10px, +0.25px tracking): badge text only, 2–4 characters.

**The 18px Ceiling.** No type above 18px. A 32px page title is a marketing tell and is out
of this world.

**The Monospace Is Data, Not Mood.** Mono is reserved for identifiers, measurements and
codes. Never for emphasis or to look technical.

## Layout

Desktop-first workspace; primary target width ≥ 1024px, tuned for 1366×768, 1440×900,
1920×1080 and Retina.

- The window *is* the workspace: no gray page with one big centered card. The web shell is
  Sidebar 224px / Header 56px / Toolbar 44px / Workspace, separated by 1px borders rather
  than shadows. `[normative spec: docs/23 §13]`
- Explorer row height 38px, column header 36px, small control 30px, normal control 34px.
  `[normative spec — not yet implemented: the Explorer surface itself is specified in docs/23
  §18 but not built.]`
- Mantine's `sm` control default renders **36px** tall in both implemented surfaces today.
  Where a denser 30/34px control is required, it is an explicit choice, not the default.
- Spacing ladder is 4 / 8 / 12 / 16 / 20. Inside a group: 4–8px. Toolbar items: 8–12px.
  Inside a content block: 12–16px. Between page sections: 20–24px. Gaps of 48px+ are not a
  layout tool here.
- Content measure: settings text blocks cap near 64ch; the extension's options column is a
  760px container on a 1280px viewport; the popup is a fixed 320px panel. `[measured]`
- Two visual worlds share the system: **Content World** (Explorer, Plaza, Activity, Search —
  flat, dense, content-led) and **Management World** (Devices, Tokens, Backups, Users,
  Settings, Jobs, Diagnostics — tables, forms, sections, status lists). Same tokens,
  different information structure.
- Narrow screens: sidebar collapses, Inspector becomes an overlay, Toolbar hides low-frequency
  actions, secondary table columns drop. The Explorer is never reflowed into a card feed.

**The Row Budget.** A 1080p Explorer view should hold 15–20 rows. If a layout choice costs
rows, it costs the product.

## Elevation & Depth

Pontis is flat at rest. Structure is carried by 1px borders, tonal surface steps
(app → workspace → raised), spacing and type; shadow is reserved for the layers that
genuinely float above the page. `[normative spec: docs/23 §11.2]`

### Shadow Vocabulary
- **None on main surfaces.** Cards, rows, sections, toolbars: border only. `[measured:
  options section card box-shadow: none]`
- **Ambient low** (`0 1px 2px rgba(0,0,0,0.06)`, token `shadows.xs`): available, used
  sparingly for small floating affordances.
- **Menu / Popover / Tooltip** (`shadows.sm`, `0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)`).
- **Modal / Command Palette** (`shadows.md`–`lg`).
- Dark mode uses the same shadow values; separation there comes from the graphite surface
  steps rather than ink.

**The Floating-Only Rule.** If the element is not above another element, it has no shadow.

## Shapes

Corner radii are small and mean different things at different scales: 4px for micro chips,
**6px for every control** (button, input, selected row), **8px for cards and menus**,
**10px for dialogs**, 12px for the rare large sheet. Full pills are for small status badges
only, never for containers. `[normative spec: docs/23 §10]`

Edges are otherwise square: the Explorer's main surface is 0–6px, tables are unrounded, and
dividers are straight 1px rules. Borders are always 1px and always low contrast
(`subtle-border` in light, `graphite-border` in dark). There is no clipping system, no
notched corner, no oversized rounding, and no container nested inside a container.

**The One-Box Rule.** A section is a bordered block, not a card holding rows that are
themselves cards. Nest a bordered block inside a card, never a card inside a card.

## Components

### Buttons
- **Shape:** gently curved (6px).
- **Primary:** accent fill (`#3f62c0`), white label, 36px tall, `0 18px` padding, 12px/500
  label. One per view; it is the action the user should take next.
- **Hover / Focus:** background deepens to `#2e4fa5` at ~100ms; focus ring is Mantine's
  auto ring in the accent hue. No lift, no shadow growth.
- **Secondary:** light tint — `accent-quiet` background, accent text. Used for a real
  alternative action.
- **Quiet / subtle:** transparent until hover, then `raised-bg`; secondary text color. This
  is the default for toolbars and row actions.
- **Destructive:** subtle variant in `sync-error`; red is for the label and border, never a
  filled red slab.

### Status badges / chips
- **Style:** pill (1000px), 18px tall, 10px/700 label with +0.25px tracking, background is
  the status ink at 10% alpha, text is that ink at full strength.
- **State:** status only — never a button, never a decorative tag. `variant="filled"` is
  reserved for the one thing that must be counted (e.g. "2 个绑定待处理").

### Cards / Containers
- **Corner style:** 8px.
- **Background:** workspace white (graphite-1 in dark).
- **Shadow strategy:** none; see Elevation.
- **Border:** 1px `subtle-border`.
- **Internal padding:** 12px (`spacing.md`), content gaps 8px.
- **Where allowed:** Plaza publications, short status summaries, empty states, onboarding.
  **Where not:** every settings item, every device row, every activity entry, KPI tiles.

### Lists and rows
- **Style:** no container per row — a bordered block separated by a 1px top rule, 12px
  vertical padding, name at 14px/600, metadata at 12px secondary. `[measured: extension
  binding list]`
- **Hover:** `raised-bg` fill only (Mantine `highlightOnHover` on tables).
- **Selected:** `accent-quiet` background with dark text.

### Inputs / Fields
- **Style:** white field, 1px border, 6px radius, 36px tall, 12px horizontal padding, label
  above at 12px, helper text below at 12px secondary. Placeholder resolves to
  `text-secondary` (`#6b717a`), not Mantine's lighter default.
- **Focus:** accent border/ring; no glow, no scale.
- **Error / Disabled:** error text below the field plus the red border; disabled drops to
  `text-disabled` and stops competing.
- Form width 400–640px; secrets never echo back.

### Navigation (web shell)
- **Style:** 224px sidebar on `app-bg`, 32–36px rows, 16–18px icons, group labels weakened,
  dividers hairline. Selected row is a pale blue field with dark text.
- **Header:** 56px, quiet — breadcrumb, search, sync status, one primary action. No giant
  page title, no brand block.
- **Command palette:** ⌘K / Ctrl-K, floating with `shadows.md`, 10px radius.
  `[normative spec: docs/23 §14–§16 — the web shell exists; the palette and Explorer
  refinements are specified ahead of implementation.]`

### Signature: the reconciliation ask
The one moment the extension is allowed to be loud: when the server's plan cannot be
committed without an answer. Ask text at 14px/600, one row per question with the item's
title and URL stacked, a compact candidate `Select` on the right, a hairline divider, then a
single filled primary action at the bottom-right. Everything else on the page steps back.

### Icons
`@tabler/icons-react` at 16–18px, stroke 1.5–1.7. Default secondary gray, active muted blue,
dangerous muted red, status icons in their semantic ink. Favicon is the main natural color
source in a bookmark list; folders stay cool gray so the page is not a wall of blue.

**The Single Primary Rule.** One filled accent button per view. A second one means the
screen has not decided what it is for.

## Do's and Don'ts

### Do:
- **Do** keep the page flat and let 1px `subtle-border` rules, spacing and type carry the
  hierarchy.
- **Do** use the compact ladder: 4/8/12/16/20 spacing, 6px controls, 8px cards, 10px
  dialogs, 12–14px content type.
- **Do** render measurements in mono with `tabular-nums` — revision watermarks, epochs, ids,
  error codes.
- **Do** let healthy states go quiet (`sync-healthy` as a 10% badge) and spend weight only on
  warning, recovery, error and questions.
- **Do** use pale blue for selection and focus (`#f0f4ff`), with dark text.
- **Do** treat dark mode as the same design: graphite surfaces, lifted accent `#5e82d6`,
  faint borders.
- **Do** state the reason and the next step in every error, and the concrete impact in every
  destructive confirmation.
- **Do** keep both surfaces reading one system; the extension imports the web theme rather
  than restyling itself.

### Don't:
- **Don't** build a KPI dashboard, a hero metric, or a card grid of settings.
- **Don't** lay down large areas of brand blue, gradient fills, glass or blur.
- **Don't** shadow main surfaces, or use a zero-offset colored halo as decoration.
- **Don't** use radii above 12px on containers, or wrap rows in cards inside section cards.
- **Don't** set type above 18px or lean on 700 weight across a page.
- **Don't** invert selection to white-on-blue, or make the sidebar a colored panel.
- **Don't** ship marketing copy in empty states, or a Pinterest-style Plaza.
- **Don't** animate for its own sake: 100–150ms for hover, opacity, menu and popover; no
  floating cards, no spring, no page slides, no blur transitions.
- **Don't** invent a second token set, a second accent, or a per-page visual language.
- **Don't** signal state with color alone.
