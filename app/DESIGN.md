---
name: Второй мозг
description: Local memory console for AI work: graphite dashboard, one indigo accent, Russian UI.
colors:
  indigo-accent: "#7c8cff"
  indigo-accent-hover: "#909dff"
  indigo-wash: "rgba(124,140,255,.14)"
  on-accent: "#0f1115"
  graphite-ground: "#0f1115"
  graphite-panel: "#16191e"
  graphite-raised: "#1c2027"
  graphite-hover: "#20252d"
  hairline: "#262a31"
  hairline-strong: "#343a43"
  text-primary: "#e6e8eb"
  text-muted: "#9aa1ab"
  text-dim: "#848b96"
  state-ok: "#3fb67f"
  state-warn: "#e0a84a"
  state-bad: "#f06a6a"
  series-obsidian: "#b7beff"
  series-chatgpt: "#8b95c9"
  series-claude: "#76a3bd"
  series-codex: "#5f6bb8"
  series-claude-code: "#6c7480"
  series-email: "#aab1bb"
typography:
  display:
    fontFamily: "Inter Tight, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.03em"
    fontFeature: "\"tnum\" 1"
  headline:
    fontFamily: "Inter Tight, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter Tight, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter Tight, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"tnum\" 1"
  body-reading:
    fontFamily: "Inter Tight, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Inter Tight, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "Cascadia Mono, Consolas, ui-monospace, SF Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "4px"
  sm: "7px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button:
    backgroundColor: "{colors.graphite-panel}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.graphite-hover}"
  button-primary:
    backgroundColor: "{colors.indigo-accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.indigo-accent-hover}"
  button-ghost:
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  icon-button:
    backgroundColor: "{colors.graphite-panel}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    size: "32px"
  input:
    backgroundColor: "{colors.graphite-panel}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  nav-item:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "34px"
  nav-item-active:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.text-primary}"
  source-chip:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "30px"
  source-chip-active:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.text-primary}"
  status-pill:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
  keyword:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.text-muted}"
    rounded: "5px"
    padding: "0 8px"
    height: "22px"
  panel:
    backgroundColor: "{colors.graphite-panel}"
    rounded: "{rounded.md}"
    padding: "16px 18px"
  stat-strip:
    backgroundColor: "{colors.graphite-panel}"
    rounded: "{rounded.md}"
    padding: "16px 20px"
---

# Design System: Второй мозг

> **Update 2026-11-21 — Liquid Glass themes.** The console now has two themes, «Графит» (default, dark) and
> «Дневное стекло» (light), switched in «Оформление» (sidebar) or Settings and remembered in `localStorage` (`theme`,
> next to `accent`). `public/glass.css`, loaded after `app.css`, re-points the tokens per theme and adds a translucent
> material only to surfaces that float over content: the sidebar, the sticky page header, the record sheet, popovers,
> the toast and the graph tools. Reading surfaces (panels, lists, tables) stay opaque. In the light theme every accent
> is re-mapped to a deeper shade with white text (contrast ≥ 4.5:1); the graph canvas has its own palette per theme.
> Motion uses two curves without overshoot — `cubic-bezier(.22,1,.36,1)` for light and release,
> `cubic-bezier(.32,.72,0,1)` for gliding — a shared hover pill and a gliding active pill in the sidebar, a gliding
> thumb in segmented controls, a cursor light inside buttons (no lift), press `scale .97` in 90 ms, blocks that enter
> once per navigation with a 45 ms stagger, and a slow field drifting behind the glass. Reduced motion keeps only colour
> and opacity changes; reduced transparency or no `backdrop-filter` gives solid surfaces. Where the text below says
> «dark only» or «no light theme», this update supersedes it; everything else (copy, density, icons, data rules) stands.

## Overview

**Creative North Star: "The Kept Console"**

The category standard played straight. The user's memory reads like a well-kept product console: a graphite ground, panels one step lighter, hairline dividers, and a single indigo accent that marks only focus, selection and the one primary action per view. The craft bar is the Vercel / Next.js dashboard for tables, charts and restraint, and Obsidian for the graph and long-text reading.

Density is a working dashboard's: 14px body, 32px controls, 8 to 24px gaps, tables and divided strips rather than floating cards. Hierarchy comes from tone steps and weight (400 / 500 / 600), never from color volume or ornament. Provider series are a muted blue-grey family, distinguishable from each other but always quieter than the accent. State color (green, amber, red) appears only where something is healthy, partial or broken.

The system is dark only, the copy is plain short Russian, and every view works at phone width (390px). It deliberately replaced an older purple UI: no glow, no gradients on surfaces, no decorative labels.

**Key Characteristics:**
- Two themes since 2026-11-21: «Графит» (dark, default) and «Дневное стекло» (light); glass only on floating layers.
- One accent (indigo) for focus ring, active marker, primary button, switches, meters.
- Tonal layering, hairline borders, almost no shadows.
- Inter Tight self-hosted, tabular figures on by default.
- Thin-stroke inline SVG icons (16px, 1.5 stroke).
- Plain, short Russian copy; sentence case; no marketing tone.

## Colors

A cool graphite neutral ladder with one indigo voice and three state colors.

### Primary
- **Console Indigo** (`indigo-accent`): focus outline (2px, 2px offset), the primary button, the active nav icon, the active detail tab underline, checked switches, checkboxes and range thumbs, the coverage meter, links, and atom-kind labels in the record card. Hover lightens to `indigo-accent-hover`. Text on it uses `on-accent` (the ground color).
- **Indigo Wash** (`indigo-wash`): text selection only.

### Neutral
- **Graphite Ground** (`graphite-ground`): page, sidebar, top bar, and the verbatim-original reading well.
- **Graphite Panel** (`graphite-panel`): panels, lists, tables, stat strip, inputs, default buttons, detail drawer.
- **Graphite Raised** (`graphite-raised`): row hover, active nav and segmented items, pills, keyword chips, tooltips, toasts.
- **Graphite Hover** (`graphite-hover`): button hover fill.
- **Hairline** (`hairline`) and **Hairline Strong** (`hairline-strong`): all borders and dividers; strong for hover borders, chart baselines, tooltips, switch tracks, inactive bar fills.
- **Text Primary / Muted / Dim** (`text-primary`, `text-muted`, `text-dim`): content; labels and secondary values; timestamps, table headers, placeholders and tertiary meta.

### State
- **Healthy Green** (`state-ok`), **Partial Amber** (`state-warn`), **Broken Red** (`state-bad`): status pills and connection states (text in the color over a 10% wash of it), the sync dot, stored-card markers, error text. Never decorative.

### Provider Series
Six muted tones, one per source (`series-obsidian`, `series-chatgpt`, `series-claude`, `series-codex`, `series-claude-code`, `series-email`), used identically in the weekly stacked chart, legend, chips, source labels, recent list dots and graph nodes. They ship as 8px squares with 2px radius, never as text color.

### Named Rules
**The One Voice Rule.** Indigo means "this is focused, selected, or the action". If an element is none of those, it is not indigo.

**The State-Only Rule.** Green, amber and red mark health and failure, nothing else.

**The Quiet Series Rule.** Provider colors stay in the muted blue-grey family and never outshout the accent; a new provider gets a tone from the same family.

## Typography

**Display Font:** Inter Tight (variable 100-900, self-hosted Latin and Cyrillic subsets) with Segoe UI Variable Text, Segoe UI, system-ui
**Body Font:** Inter Tight, same stack
**Label/Mono Font:** Cascadia Mono with Consolas, ui-monospace (keyboard hints and provenance hashes only)

**Character:** One tight, neutral UI sans carries everything; weight and size do the hierarchy, tabular figures keep counts aligned.

### Hierarchy
- **Display** (600, 28px, 1.25, -0.03em): stat-strip values and big numbers; 22px at phone width.
- **Headline** (600, 24px, 1.2, -0.025em): the page title; 21px at phone width. Record-card titles step down to 19px / 1.3.
- **Title** (600, 14-15px, -0.015em): panel and section headings, record titles (14.5px).
- **Body** (400, 14px, 1.5): default UI text; 13px inside tables, rows, chips and controls.
- **Body Reading** (400, 14px, 1.65, max 72ch): the verbatim original and card description (68ch).
- **Label** (500, 12-13px): stat labels, table headers, pills, legends, meta; 12.5px for small helper text. Sentence case, no tracking, never uppercase.

### Named Rules
**The Weight-Not-Color Rule.** Hierarchy steps through 400 / 500 / 600 and the three text tones; headings are never colored.

**The Tabular Rule.** Every count, date and amount uses tabular figures (on globally via `tnum`).

## Layout

Fixed 232px left sidebar (wordmark, search with `/` hint, nav, divider, secondary nav, provider list, sync status pinned to the bottom) and a fluid main column (padding 24px 32px 48px, max 1680px). The record card opens as a right drawer `min(460px, 40vw)` and pushes main aside on wide screens.

Spacing steps actually reused: 4, 8, 12, 16, 20, 24, 32px. Panel padding is 16px 18px; table and list rows run 10-11px by 18px; gaps between panels are 16px; between page sections 20px.

Overview: a four-cell divided stat strip, then a 1.7fr / 1fr grid (weekly chart beside the fresh list; sources table beside projects). Settings: 1.4fr / 1fr. Connections: auto-fill cards of at least 300px.

Responsive:
- At 1280px the overview grid collapses to one column.
- At 1100px the drawer overlays instead of pushing.
- At 900px the sidebar becomes a 52px sticky top bar with a slide-in sheet (scrim behind), main padding drops to 16px, strips go 2x2, settings stack, the projects table drops a column, the graph is 62vh, and touch targets grow to 38-40px.
- At 560px tables become stacked two-column rows without a header, form grids go single column, and chart week labels thin out.

## Elevation & Depth

Flat by default. Depth is tonal: ground, panel, raised, each a step lighter, separated by 1px hairlines. Shadows appear only on things that float above the page.

### Shadow Vocabulary
- **Drawer** (`box-shadow: -12px 0 32px rgba(0,0,0,.3)`): record detail drawer.
- **Sheet** (`box-shadow: 12px 0 32px rgba(0,0,0,.4)`): phone sidebar sheet.
- **Toast** (`box-shadow: 0 8px 24px rgba(0,0,0,.4)`): toast messages.
- **Tooltip** (`box-shadow: 0 6px 18px rgba(0,0,0,.35)`): graph tooltip.
- **Inset hairline** (`box-shadow: inset 0 0 0 1px #262a31`): active nav and segmented items, in place of a border.

### Named Rules
**The Float-Only Shadow Rule.** A shadow means the surface sits above the page (drawer, sheet, toast, tooltip). Panels and cards never get one.

## Shapes

Gently rounded and consistent: 10px for panels, lists, tables, strips and the graph frame; 7px for controls (buttons, inputs, nav items, search, segmented); 5-6px for inner chips and tags; 999px for pills, chips and switches; 2px for series squares; 3px for chart bar tops and meter tracks. Borders are always 1px hairlines. Rows inside a container are divided by hairlines, not separated into cards.

## Components

### Buttons
Quiet, compact, bordered.
- **Shape:** gently rounded (7px), 32px tall, 12px side padding, 13px / 500.
- **Default:** panel fill, hairline border, primary text. Hover: hover fill and strong hairline.
- **Primary:** indigo fill and border, ground-colored text; at most one per view (Обработать). Hover lightens.
- **Ghost:** no fill; hover gets the panel fill.
- **Toggled:** indigo border and text (`.btn.active`, `.icon-btn.active`).
- **Icon button:** 32px square, muted icon, 40px on phones.
- **Disabled:** 50% opacity.

### Chips
- **Source chip:** 30px pill, hairline border, muted text, series square, dim count. Active: raised fill, strong hairline, primary text.
- **Status pill:** 22px pill on raised fill with a 6px dot in currentColor; ok / warn / bad versions use the state color over a 10% wash.
- **Keyword:** 22px, 5px radius, raised fill, muted text.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** graphite panel.
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px hairline.
- **Internal Padding:** 16px 18px; heading row 14px above content.

### Inputs / Fields
- **Style:** panel fill, hairline border, 7px radius, 32px tall, 10px padding, 13px. Selects carry a drawn muted chevron.
- **Focus:** border turns indigo; the global focus ring is a 2px indigo outline at 2px offset.
- **Field labels:** 13px / 500 muted above, 12px dim hint below.
- **Switch:** 36x20 track in strong hairline, indigo when on.
- **Segmented control:** panel container with 3px inset; active segment raised with an inset hairline.

### Navigation
- **Sidebar items:** 34px, 7px radius, muted 500 text with a 16px stroke icon and a dim count at the right. Hover: panel fill, primary text. Active: raised fill, inset hairline, primary text, indigo icon.
- **Phone:** 52px sticky top bar with wordmark and menu button; the sidebar slides in as a sheet over a 50% black scrim.
- **Detail tabs:** text tabs with a 2px indigo underline on the active one.

### Stat Strip (signature)
One bordered panel split into four cells by vertical hairlines: muted label, 28px tabular value, dim sub-line. Each cell is a button that opens the records behind the number; hover raises the cell. 2x2 below 900px.

### Weekly Stacked Chart (signature)
Columns of provider-colored stacks (max 34px wide, 3px top radius) over a strong hairline baseline and one hairline mid gridline, dim 11px axis and week labels, value tooltip on hover or focus. The legend beside it carries per-provider counts and a ruled total.

### Graph Canvas (signature)
Canvas in a 10px framed well with a faint radial deepening toward the ground. Nodes are provider-colored discs clustered by project with dim project names in 600 weight; edges are faint grey hairlines that light up in the focused node's series color. The focused node gets a white ring and a ground-backed label. Controls are icon buttons stacked top-right; caption bottom-left.

### Record Drawer
Right drawer on the panel fill with a sticky header, title at 19px, provenance line, text tabs, sections divided by hairlines, atoms separated by dashed hairlines, and the verbatim original in a ground-colored reading well (72ch, 1.65 line height).

## Do's and Don'ts

### Do:
- **Do** keep both themes on the same tokens (`--bg`, `--panel`, `--raised`, `--line`, `--text`…): re-point them in `glass.css`, never hard-code colors in components.
- **Do** use indigo `#7c8cff` only for focus, selection, toggled state and the single primary action.
- **Do** build hierarchy with tone steps, 1px hairlines and weights 400 / 500 / 600.
- **Do** use tabular figures for every number and read every number from the live API.
- **Do** write labels in plain short Russian, sentence case.
- **Do** draw icons as inline 16px SVG with a 1.5 stroke in currentColor.
- **Do** check every view at 390px: top bar, 2x2 strip, stacked table rows, 38-40px touch targets.
- **Do** honor `prefers-reduced-motion` (all transitions off); keep motion to 150ms color and opacity changes and the 200ms ease-out sheet slide.

### Don't:
- **Don't** put glass on reading surfaces or stack translucent layers; glass is for what floats over content.
- **Don't** introduce a second accent, purple glow, or gradient fills on panels and buttons.
- **Don't** put shadows on panels or cards; shadows are for floating layers only.
- **Don't** use eyebrow or kicker labels, uppercase tracked labels, or emoji and glyph icons.
- **Don't** use state colors (green, amber, red) for anything but health and errors.
- **Don't** render source texts as HTML; the original is shown verbatim as plain text.
- **Don't** load fonts or assets from the network; everything is served locally.
