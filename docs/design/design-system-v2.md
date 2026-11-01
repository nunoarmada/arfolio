# Arfolio Design System v2 — "Calm Console"

Status: v2 (redesign) · Date: 2026-10-31 · Supersedes the visual sections of `design-system.md` (v1 principles on
calm money semantics, accessibility and white-label still apply).

## 1. Audit

### 1.1 Systemic root causes (fix these first; they explain about 90% of the harness errors)

| # | Root cause | Evidence (route @ viewport) | Code |
|---|---|---|---|
| R1 | **Grid min-content blowout.** Many stacks use `grid gap-*` with no column template. The implicit `auto` track grows to the min-content width of its children, and any `truncate` or `whitespace-nowrap` text inside an `inline-flex`, a flex button or a table contributes its full width. | transactions @768–1440: the account name runs over the amount and the amount gets clipped. **This is the "tables cut off on desktop" the owner sees.** Also: accounts/savings-long-name page 1655px wide at every desktop size; home @375/1024/1280 (accounts card); investment holdings @375 (592px); subscriptions @375; the "19" bell badge floating outside the sidebar on every page at lg+. | `components/account-badge.tsx:45` (`inline-flex`, min-content = full name) inside `transaction-row.tsx:90` (`md:block`); `transactions-view.tsx:357` (`li.grid` with no columns); `app/(app)/(shell)/accounts/[id]/page.tsx:73`, `accounts-view.tsx:88`, `page.tsx:92` (`grid gap-6`); `accounts/home-accounts.tsx:47`; `holdings-section.tsx:276,338`; `subscriptions-view.tsx:347`; `(shell)/layout.tsx:78` (sidebar footer `grid gap-3`: the user's name widens the column, so the bell's `ml-auto` badge lands at x≈280); `shell/user-menu.tsx:44` |
| R2 | **Clipping instead of scrolling.** | net-worth/asset @1024: the history table runs past the viewport and the Nota column is lost | `net-worth/history-list.tsx:145` (`overflow-hidden … md:block` around the table); `:183` (`max-w-[16rem] truncate` on a `td` does nothing in auto table layout); `transactions-view.tsx:363` (`min-h-0 overflow-hidden` clips once R1 blows out) |
| R3 | **Shell geometry.** The sidebar expands to 248px at `lg` (1024), leaving 712px of content, the exact width where every 4-column layout cramps. The `max-w-[1200px]` main cap, plus nested 640/720 caps on list pages, leaves half-empty screens at 1440+. | transactions @1024 (account column about 120px wide); asset detail @1024 (the 7/12 column is about 400px); subscriptions, reports and budgets lists @1440 (content stops at 720px) | `(shell)/layout.tsx:72` (`lg:w-[var(--sidebar-width)]`), `:92` (`max-w-[1200px]`); `subscriptions-view.tsx:220,235`, `budgets-list.tsx:135`, `transfer-plan-view.tsx:72`, `insights/reports/page.tsx:64` (all `max-w-[720px]`) |
| R4 | **Year grid wastes width.** The Grupo and Conta columns (about 300px) sit before the months. At 1024 only Jan–Feb are visible, the yearly total is never visible, nothing signals that the table scrolls, and it has its own nested vertical scroll. | budget/year @1024–1440 | `budget/year-grid.tsx:43` (`NAME_WIDTH`), `:400–404` |
| R5 | **Mobile scroll regions give no cue.** | filter chip row (909px inside 375); report comparison table (422px inside 341); schedule table (320px inside 307); detail sheet (490px inside 479) | `filter-bar.tsx:148` area; `reports/[month]` table; `schedule-card.tsx`; `transaction-sheet` |

False positives to exclude from the harness: the `clipped` `input` findings (long values in a text input scroll natively); `/setup` returning 404 after setup; `home__user-menu` @375 (the user menu lives in /more on phones).

### 1.2 Visual and UX weaknesses

1. **The home page isn't a dashboard.** There is no KPI overview. A 44px **red** "Acima 84,70 €" dominates the page, the right column ends half-way down at 1440, and the section titles float outside their cards.
2. **Flat depth.** White cards with a 1px border sit on near-white `oklch(0.985)`, so the layers barely separate. Dark mode looks the same.
3. **Signal dilution.** Count badges (nav "10", bell "19") use the warning amber. Budget lines that are exactly paid ("Restam 0,00 €") show in amber, so most of the budget page is amber.
4. **Chunky desktop controls.** Every button is 44px tall, and the account detail page has four outline buttons including "Apagar conta" in plain view.
5. **Three stacked segmented controls** on budget/year (section nav, period, view). Section navigation should not look like a view toggle.
6. **Weak type character.** IBM Plex reads institutional, not "digital SaaS". Page titles are 24px and KPI figures aren't distinct from body text.
7. **Wrapping metadata.** Connection timestamps break mid-unit ("há 2 / h").

---

## 2. Design direction: "Calm Console"

A precise instrument panel for household money: layered surfaces, generous numbers, one chromatic signal (the brand), and red only when something is actually wrong. References: Stripe Dashboard (data density), Linear (shell and restraint), Mercury (financial calm), Copilot Money (KPI clarity).

Principles:
1. **Overview, then detail.** Every top-level page opens with a KPI strip that answers its question; tables and lists come after.
2. **Depth means hierarchy.** Canvas, then card, then raised, then overlay. Each step is visible in both modes; no glassmorphism except the mobile bars.
3. **Brand is the accent, not the paint.** The derived primary appears in the active nav, primary actions, the household's own chart series and one hero glow per page.
4. **Numbers are typography.** Tabular figures, dimmed cents on hero values, right-aligned columns, and nothing truncates a money value. Ever.
5. **Calm semantics.** Red is for over budget, negative balances and failures. Counts are neutral or brand. Exactly-met plans read as done.

## 3. Design system v2

### 3.1 Typography
- **Family:** Geist Variable, `@fontsource-variable/geist` (OFL; package exists, 5.3.0). Load it the same way as today in `app/layout.tsx` with `localFont({ src: '../../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', weight: '100 900', variable: '--font-sans-v2' })`. Remove the Plex package once this is done.
- **Phase 0 gate:** render `111,11 €` above `888,88 €` with `tabular-nums` and confirm the widths are equal. If they aren't, use `@fontsource-variable/inter` with `font-feature-settings: 'tnum','cv11'`.
- Numerals: `tabular-nums` on every money value, count, table date and percentage.

| Token | Size/LH | Weight | Tracking | Use |
|---|---|---|---|---|
| `display` | 40/44, md 48/52 | 600 | −0.035em | one hero value per page, cents at 0.6em muted |
| `kpi` | 26/32, xl 30/36 | 600 | −0.025em | KPI tiles |
| `title` | 24/30, md 28/34 | 650 | −0.02em | h1 |
| `heading` | 18/26 | 600 | −0.01em | h2 sections |
| `card-title` | 15/22 | 600 | 0 | card headers |
| `body` | 16/24 | 400 | 0 | prose, inputs (16 minimum on <md) |
| `body-sm` | 14/20 | 400–500 | 0 | table cells, row meta |
| `label` | 13/18 | 500 | 0 | KPI labels, table headers (sentence case) |
| `caption` | 12/16 | 500 | +0.01em | axes, chips |

### 3.2 Tokens (OKLCH). Keep neutrals at hue 260. Update `BACKGROUND` in `packages/core/src/brand.ts` and `BACKGROUND_HEX` in `lib/brand.ts` to the new `--background` values.

| Token | Light | Dark |
|---|---|---|
| `--background` (canvas) | 0.972 0.003 260 | 0.145 0.006 260 |
| `--sidebar` | 0.99 0.002 260 | 0.165 0.006 260 |
| `--surface` (card) | 1 0 0 | 0.19 0.007 260 |
| `--surface-raised` (popover/sheet) | 1 0 0 | 0.215 0.008 260 |
| `--surface-2` (inset, table header, hover) | 0.962 0.004 260 | 0.225 0.008 260 |
| `--surface-3` (track, pressed) | 0.93 0.005 260 | 0.265 0.009 260 |
| `--border` | 0.915 0.004 260 | 0.28 0.008 260 |
| `--border-strong` (totals, sticky col edge) | 0.86 0.006 260 | 0.34 0.01 260 |
| `--input` (≥3:1) | 0.66 0.008 260 | 0.52 0.01 260 |
| `--foreground` | 0.20 0.012 260 | 0.965 0.003 260 |
| `--muted-foreground` | 0.48 0.012 260 | 0.73 0.01 260 |
| `--subtle-foreground` | 0.62 0.01 260 | 0.58 0.01 260 |
| `--positive` / `-soft` | 0.52 0.13 155 / 0.962 0.03 155 | 0.76 0.14 155 / 0.27 0.05 155 |
| `--negative` / `-soft` | 0.53 0.19 27 / 0.962 0.025 27 | 0.72 0.16 25 / 0.28 0.06 25 |
| `--warning` / `-soft` | 0.55 0.13 65 / 0.965 0.04 85 | 0.80 0.13 80 / 0.29 0.05 80 |
| `--transfer` / `-soft` | 0.50 0.05 250 / 0.955 0.012 250 | 0.74 0.05 250 / 0.27 0.02 250 |
| `--chart-1…8` | keep v1 values | keep v1 values |
| `--chart-grid` | var(--border) | var(--border) |
| `--overlay` | 0.15 0.01 260 / 0.40 | 0.05 0 0 / 0.60 |

**Shadows** (borders move into the shadow ring, so cards drop the `border` class):
- Light. `--shadow-xs: 0 1px 2px oklch(0.2 0.02 260/0.05)`. `--shadow-card: 0 0 0 1px oklch(0.2 0.02 260/0.06), 0 1px 2px oklch(0.2 0.02 260/0.04), 0 2px 8px -2px oklch(0.2 0.02 260/0.06)`. `--shadow-raised: 0 0 0 1px oklch(0.2 0.02 260/0.06), 0 6px 20px -6px oklch(0.2 0.02 260/0.14)`. `--shadow-overlay: 0 0 0 1px oklch(0.2 0.02 260/0.08), 0 24px 48px -12px oklch(0.2 0.02 260/0.25)`.
- Dark. Same names, built as `inset 0 1px 0 oklch(1 0 0/0.04), 0 0 0 1px oklch(1 0 0/0.07), 0 2px 8px oklch(0 0 0/0.4)`, with larger blur and 0.55 alpha for raised and overlay.

**Radii:** `--radius` 12px (cards); sm 6 (chips); md 8 (inputs, buttons); xl 16 (hero cards, sheets); full (pills, badges).

**Motion:** keep 120/180/260ms and the current easings. Interactive cards lift `translateY(-1px)` plus `--shadow-raised` on `pointer-fine` hover. No number count-ups. Keep the reduced-motion block.

**Layout:** `--tabbar-height` 64; `--topbar-height` 56; `--rail-width` 72; `--sidebar-width` 256.

### 3.3 Brand derivation (extend `deriveBrand`; still no hex in components)
Server-side maths emitted into the existing injected `<style>`:

| Token | Light | Dark |
|---|---|---|
| `--primary` | existing clamp | existing clamp |
| `--primary-hover` | L −0.05 | L +0.04 |
| `--primary-text` (links, active nav label) | L = min(L, 0.50), so ≥4.5:1 on surface and surface-2 | L = max(L, 0.76) |
| `--primary-2` (gradient partner) | same L, C×0.9, H+18, `fitChroma` | same rule |
| `--primary-glow` | primary at α 0.14 | primary at α 0.22 |

CSS-derived tokens:
- `--primary-soft: color-mix(in oklab, var(--primary) 10%, var(--surface))` (16% in dark)
- `--primary-soft-strong`: 18% (26% in dark)
- `--primary-border: color-mix(in oklab, var(--primary) 35%, var(--border))`
- `--brand-gradient: linear-gradient(135deg, var(--primary), var(--primary-2))`. Decorative only (logo tile, auth panel, hero accent line). Never put text on it unless the contrast test covers it.

Unit-test every token pair for teal `#1a6b7c`, navy `#1e3a8a`, orange `#ea580c`, purple `#7c3aed`, yellow `#facc15` and red `#dc2626`. For red brands (hue within ±20° of 27), `--negative` stays and is always paired with an icon and text.

## 4. Components

**App shell** (`(shell)/layout.tsx`)
- **<md:** sticky top bar, 56px, `bg-background/80 backdrop-blur-md`, border once scrolled. Bottom tab bar, 64px plus safe area, `bg-surface/85 backdrop-blur-md` with a top hairline. Active tab: a 56×32 pill in `primary-soft` behind the icon, label in `primary-text` 12/600. Count badges are solid `--primary`, 20px, 11/600.
- **md–lg (768–1279):** a 72px icon rail. Labels are visually hidden, with a CSS tooltip on hover and focus-visible (`aria-label` on the link). The brand mark shows the logo only.
- **≥xl (1280):** a 256px sidebar on `--sidebar` with a right hairline. Top: brand (32px logo tile on `--brand-gradient` when there's no logo image, plus the name, one line, truncated, with `title`). Then the main nav. Footer: notifications, settings, user card. **Every grid in it uses `grid-cols-1`.**
- **Active nav item:** `primary-soft` background, `primary-text` label and icon, and a 3px inset indicator bar in `--primary`.
- **Content:** `main` is `min-w-0 flex-1` with no global max-width. Padding is x 16 / md 24 / xl 32 / 2xl 40, and y md 24 / xl 32.
- **New `PageContainer width`:**
  - `full`: no cap. Transactions, year grid, import.
  - `wide`: `max-w-[1480px] mx-auto`. Dashboards and lists.
  - `narrow`: `max-w-[760px]`. Forms, settings detail, wizards.
  - Remove the per-page 640/720 caps on list pages.

**PageHeader**
- Row: h1 (`title`) with an optional description underneath (14 muted); actions on the right, wrapping below on <sm.
- New `tabs` slot: underline tabs (h-10, 14/500, active = `primary-text` with a 2px `--primary` underline, horizontally scrollable with edge fade). These replace the segmented `budget-nav`, `insights-nav`, `net-worth-nav` and the accounts nav.
- The segmented control stays only for in-page view toggles.
- h1 truncates to 2 lines on phones and 1 line from md up, with `title`. Its parent must be `min-w-0`.

**Card**
- `default`: surface, radius 12, `--shadow-card`. Padding 16 / md 20 / xl 24.
- `inset`: surface-2, no shadow, for nested content.
- `hero`: radius 16, plus `radial-gradient(120% 140% at 100% 0%, var(--primary-glow), transparent 60%)` and a 1px top line in `--primary-border`.
- `interactive`: adds the hover lift and a full-card link (a single `<a>`).
- `tone="negative|warning"`: the `-soft` background, a ring in the tone at 30%, and an icon.
- Card header lives **inside** the card: `card-title`, an optional 13px muted description, and on the right a "Ver tudo" link (14/500 `primary-text` with a chevron). Full-bleed divided rows go in the body.

**KPI tile**
- Label row: a 28px rounded-md icon tile in `primary-soft` with a 16px icon, plus a `label`.
- Then the `kpi` value; cents dimmed only in the hero variant.
- Meta row: a delta chip (arrow icon, signed amount, %) plus comparison text ("face a setembro"), 13 muted, `whitespace-nowrap` per chip with the row allowed to wrap.
- Optional footer: a sparkline (36px, 1.75px `--primary` stroke, area `--primary-glow`→0) **or** a 6px progress bar with a pace tick.
- Delta chip tones: favourable = positive-soft; unfavourable but fine = surface-2 / muted; only a real problem uses negative-soft.
- Tiles sit in `grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4`. At 375 the value drops to 22px.

**Section header** (between cards): `heading` plus a count chip, with a tabular muted aggregate and an action on the right.

**List row**
- Min height 56 (60 on <md). 36px avatar, 15/500 title, 13 muted meta.
- Trailing amount 15/600 tabular, `shrink-0` and never truncated. The text column is `min-w-0`.
- Hover `surface-2`; focus-visible inset ring.
- Day-group band: surface-2, 13/600 date, tabular net total on the right.

**Data table pattern** (new `DataTable` plus a `ScrollRegion` wrapper)
- `ScrollRegion` is `role="region" aria-labelledby tabIndex=0 overflow-x-auto`. A `useScrollEdges` hook sets `data-start` and `data-end`, which drive 16px gradient edge shadows (pseudo-elements, `pointer-events-none`) and the sticky first column's right shadow.
- Table: `border-separate border-spacing-0`. Header 40px on surface-2, `label` style. Rows 44px (48 on coarse pointers), 14px. Numbers right-aligned and tabular. Totals row is 600 weight with a top `--border-strong`.
- When a column must truncate, use `table-fixed` plus `<colgroup>`; put the truncation on an inner `span`.
- Sticky header only inside self-scrolling tables (the year grid); elsewhere tables are short.

| Table | ≥lg | md | <md |
|---|---|---|---|
| Transactions feed | grid list, columns `2.25rem minmax(0,2fr) minmax(0,1fr) minmax(10rem,1fr) 9rem` | 3 columns (account moves into the meta line) | 2-line rows |
| Budget year | table in its own scroll area (`max-h: calc(100dvh - 12rem)`), sticky header, sticky name column (200px; group and account as 2nd line; **Grupo and Conta columns removed**), sticky right "Total" column | same, name column 168px, no sticky total | same, name column 148px |
| Budget month lines | grid rows; add Real / Previsto / Estado columns at xl | grid rows | stacked |
| Subscriptions | table: Nome · Conta · Frequência · Próximo · Valor · Ações | cards | cards |
| Holdings | table with sticky name column (table today starts at md: `holdings-section.tsx:141`) | cards | cards |
| Asset/liability history | `table-fixed` in ScrollRegion: Data 7.5rem, Valor 9rem, Origem 7rem, Nota auto, Ação 3rem | same | list |
| Liability schedule | Mês · Prestação · Juros · Capital · Em dívida (5 columns at xl; stacked cell at sm–lg) | stacked cell | list |
| Report comparison, trends | table | table | stacked `dl` rows |
| Import preview | ScrollRegion with sticky header and first column, always | same | same |
| Home upcoming, settings lists | list rows | list rows | list rows |

**Progress**
- 8px (6px compact), radius full, track surface-3.
- Fill colour: `--primary` while on track; `--positive` for income received; `--warning` from 90% of plan; `--negative` when over (fill 100% plus a hatched overflow cap).
- Pace tick: 2px `foreground/50` with a "Hoje" caption.
- An exactly-met fixed line shows a neutral "Pago" with a check, never warning.

**Badges and chips**
- Count badge: solid primary.
- Status chip: 22px, 12/500, pill, soft background plus a 6px dot plus a text label.
- AI chip: surface-2 with a sparkles icon.
- Filter chip: h-10 on <md, h-9 on md+. Selected = `primary-soft-strong` plus `--primary-border`.

**Buttons**
- Sizes:
  - default: `h-11` on <md and coarse pointers, `md:pointer-fine:h-9`
  - sm: h-8
  - lg: h-10 (h-12 on mobile)
- Primary: `--primary`, hover `--primary-hover`, `shadow-xs` plus `inset 0 1px 0 oklch(1 0 0/0.12)`.
- Secondary (default for toolbars): surface with the shadow ring.
- Ghost, link (`primary-text`).
- Destructive only inside confirm dialogs; destructive entry points go into a "⋯" menu.

**Inputs**
- 44px with 16px text on <md; 40px with 15px text on md+ pointer-fine.
- Border `--input`. Focus: `--primary` border plus a 3px `primary-soft-strong` ring (outline kept for focus-visible).
- Error: `--negative` border plus a message below with an icon, linked through `aria-describedby`.

**Sheets and dialogs**
- Sheet: right side, 480px, on md+; bottom sheet with a drag handle and radius-xl top on <md. `--shadow-overlay`; overlay scrim with a 2px blur. Fix the 490/479px overflow inside the detail sheet (apply R1 to its grids).
- Dialog: 440px wide.

**States**
- Empty: 40px `primary-soft` icon tile, 16/600 title, 14 muted body at most 52ch wide, CTA.
- Loading: skeletons matching the final geometry, with the 200ms delay plus a shimmer.
- Error: an in-place card (keep `BlockError`) with an icon, one sentence, and a "Tentar novamente" secondary button.

**Charts** (custom SVG)
- The household's own series is a 2px `--primary` line with an area gradient from `--primary-glow` to 0, and a dashed projection for the current month.
- Gridlines: 1px `--chart-grid`, dash `2 3`. Axis text 12 muted tabular.
- Bars use radius 4 and the categorical palette, with slot 8 for "Outros".
- Hover/focus crosshair with a tooltip card (raised, 13px).
- `role="img"` plus a summary `aria-label`, and keep "Ver como tabela".

## 5. Pages

**Home** (`page.tsx`), a 12-column grid with gap 16 / xl 24:
- KPI strip of 4 tiles:
  1. **Disponível** (available, "em N contas")
  2. **Gasto este mês** (actual vs planned spending, progress bar plus pace; negative chip only when over)
  3. **Poupança do mês** (actual vs planned savings from `BudgetMonthView`; falls back to monthly spending when there's no budget)
  4. **Património líquido** (delta vs last month plus sparkline)
- Layout by breakpoint:
  - <md: alerts as compact tone cards, then KPIs 2×2, Budget, To review, Upcoming, Net worth, Accounts.
  - md: same order.
  - lg: KPIs 4×3, then Budget (col 7) with Upcoming + To review (col 5), then Net worth chart (col 7) with Accounts (col 5).
  - xl+: KPIs 4×3, then **Budget** (col 8: progress, top 3 over or near lines, link) with **Para fazer** (col 4: review count, connections needing attention, subscriptions to confirm), then **Net worth evolution** (col 8, 12-month area chart) with **Próximos pagamentos** (col 4), then **Contas e ligações** (col 12, account mini-cards in `repeat(auto-fill,minmax(240px,1fr))`, with sync status as a chip whose time is `whitespace-nowrap`).
- The blocking connection banner stays at the top as a `tone="negative"` card.

**Transactions:** `full` container.
- Header: "Adicionar" primary; the review callout becomes a slim warning card with a count and "Rever".
- Toolbar: search (max 420px) plus filter chips on one row at lg+, wrapping; on <md the chip row scrolls with edge fade.
- Feed as specified in §4. The column header row is `aria-hidden` and uses the same grid template as the rows.

**Budget:**
- Header tabs: Mês · Ano · Transferências · Subscrições, with the period stepper on the right of the tab row at md+.
- Month: KPI strip (Despesas vs previsto with progress, Receitas, Poupança, Por atribuir). Then lines in col 8 (xl) beside a sticky aside in col 4 (top 24px): plano de transferências, fora do orçamento. Stacked below xl.
- Year: `full` container. Toolbar: year stepper, the Previsto/Real/Diferença segmented control, and on the right "Adicionar rubrica" plus a "⋯" menu (import, new budget, manage). Table as in §4.
- Subscriptions: KPI tile (monthly cost) plus a "Por confirmar" table (lg) with inline Confirmar/Ignorar.

**Net worth:**
- Hero card (col 4: value, delta, a two-tone assets/liabilities ratio bar) beside the evolution chart card (col 8).
- Assets and liabilities in two columns at lg (stacked below). Each group is a card with a subtotal and share %.
- Detail pages: lg 5/7, xl 4/8. The hero card holds the value, update action and facts. The right side holds the chart card, then the history/schedule table in a ScrollRegion. The liability facts use a 3-column `dl`.

**Accounts:**
- KPI strip: Disponível, Cartões (debt), Investimentos, Ligações com problemas.
- Groups as cards. At xl, `grid-cols-2` of group cards when there are 4 or more groups.
- Detail: hero card (balance, type, institution, last sync chip). Toolbar: Importar extrato (primary), Editar (secondary), ⋯ (Arquivar, Apagar). Then holdings, then the feed.

**Insights:**
- Tabs: Gráficos / Relatórios. Controls row: period segmented control on the left, stepper on the right.
- Cards: Despesas por grupo (col 7), Fluxo de caixa (col 5), Evolução (col 12).
- Report: xl 8/4. Main column: AI summary as a hero card with an AI chip, then highlights and suggestions. Aside: key-number KPIs and anomalies. Prose capped at 68ch.

**Settings:**
- xl: two panes, a sticky 260px subnav plus a `narrow` content area.
- <xl: the current index → detail flow. Index rows get 36px icon tiles, grouped into cards (Agregado, Pessoas, Dados, Conta).

**Auth (sign-in, 2FA, invite):**
- lg+: split screen. Left half is a `--sidebar` panel with a `--brand-gradient` glow, the logo and the brand name, plus an abstract primary chart-line motif (no invented claims). Right half holds the 400px form card.
- <lg: a centred card under the brand mark.

## 6. Implementation phases

| Phase | Scope | Acceptance (screenshot harness, all 7 viewports) |
|---|---|---|
| 0 Foundation | Geist + tnum gate; v2 tokens; `deriveBrand` extras with contrast unit tests (6 brands × 2 modes); **R1 sweep**: every stacking `grid` → `grid-cols-1` (Tailwind v4 = `minmax(0,1fr)`), AccountBadge → `flex max-w-full`; **R2**: history-list wrapper → ScrollRegion | `report.md`: 0 `document-overflow`, `beyond-viewport` and `clipped` (non-input) entries; contrast tests green |
| 1 Shell | rail at md–lg, sidebar at xl, PageContainer, PageHeader tabs, tab and top bars | content ≥ 900px at 1024; nothing renders outside the sidebar; no list page leaves more than 25% of the 1440 width empty; focus ring visible on every nav item |
| 2 Shared | Card, KpiTile, SectionHeader, ScrollRegion/DataTable, Progress, badges, button and input sizes, states, chart primitives | buttons are 36px at 1280/1440 and 44px at 375/768 |
| 3 Home | §5 grid + KPIs | no column is more than 120px shorter than its neighbour at xl; red appears only in the over-budget chip |
| 4 Transactions + Accounts | feed columns, toolbar, account detail, holdings | full amounts visible at 768–1440 with long account names; holdings @375 fit |
| 5 Budget | month, year (R4), subscriptions, transfers | year @1024 shows ≥4 months plus the name column; edge shadow present; no amber on fully paid lines |
| 6 Net worth | hero, chart, detail tables | asset history @1024 shows all 5 columns |
| 7 Insights + Reports | grid, report layout, mobile stacked tables | no `table-hscroll` at 375 for report and trends tables |
| 8 Settings, Auth, Import, Connections | two-pane settings, split auth | sign-in @1440 split; 2FA @375 unchanged in function |
| 9 Polish | dark pass; brand matrix run (`BRAND_PRIMARY_COLOR` = the 6 test colours) at 375 and 1440; keyboard pass; reduced motion; `impeccable detect --json apps/web/src` | detector clean; every brand screenshot reads as intentional |

---

**Decisions and rationale:**
- I fixed the "cut-off tables" at the root (implicit grid tracks plus `inline-flex` truncation) instead of widening layouts. One rule, `grid-cols-1`, fixes it across about 15 components.
- The sidebar expands at xl rather than lg: 1024 is the cramped band, and a rail there gives tables about 190px back.
- I dropped the 1200px cap in favour of per-page container widths. Data pages earn the width; forms stay readable.
- Geist gives the "digital SaaS" character and has a full weight range, gated on verified tabular figures, with Inter as the fallback. Plex reads as banking.
- Depth comes from shadow rings plus a darker canvas, not borders. In dark mode it comes from lightness steps and a top highlight, so both modes are first-class.
- The extra brand tokens are computed server-side in `deriveBrand`, which keeps white-label safe and avoids depending on browser support for relative colour syntax.

## 7. Decisions on the open questions

- **Typography:** the owner delegated the choice; Geist Variable replaces IBM Plex Sans (Inter as fallback if the
  tabular-figure gate fails).
- **Home KPI 3:** "Poupança do mês" (actual vs planned savings) when a budget exists; otherwise "Fluxo do mês"
  (income minus spending this month).
- **"Despesas por grupo" on home:** included at xl+ only if it reuses an existing service call without a new query
  path; otherwise left out (builder's call).
