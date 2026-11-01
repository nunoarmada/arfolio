# Arfolio Design System and UX Brief (v1)

> Historical: this is the original v1 brief, written under the project's working name. The current visual system is [design-system-v2.md](design-system-v2.md); the principles here on calm money semantics, accessibility and white-label still apply.

Status: v1 for Phase 0–1 build · Date: 2026-10-18 · Architecture today: [architecture.md](../architecture.md)

Surface mode: **Operate** (app UI). Expression comes from precision, restraint and the brand colour, not from
decoration. The product name, logo and primary colour are installation config; nothing in this document may be
hard-coded as a brand string or brand hex in components.

---

## 1. Design principles

1. **The 10-second answer.** Every top-level screen opens with the one sentence and one number that answer
   its question ("Este mês está dentro do plano · restam 1 240,00 €"). Detail sits below the fold, never in front.
2. **Numbers first, chrome last.** Money is the content. Amounts get the strongest type, tabular figures and
   right alignment; borders, icons and colour stay quiet so the figures read clean.
3. **Calm by default, loud only when it matters.** Most movements are expenses; colouring them all red turns
   the app into an alarm. Expense amounts use the normal text colour. Red is reserved for real problems:
   over budget, negative balance, failed sync, expired consent.
4. **Trust through visible state.** Every number shows where it came from and how fresh it is: last sync time,
   pending vs booked, who or what categorised it (rule, memory, AI with confidence, a person). Nothing fails
   silently.
5. **One thumb, one tap.** Reviewing and categorising is the main recurring job, done on a phone. The common
   action is one tap within the thumb zone, with undo instead of confirmation dialogs.

---

## 2. Visual direction

### 2.1 Typography

- **Family:** `IBM Plex Sans` (variable via `next/font/google`, axes `wght` 100–700 and `wdth` 85–100, subsets
  `latin`, `latin-ext`). Institutional, legible at small sizes, full Portuguese diacritics, real tabular and
  slashed-zero figures. One family for everything; no mono, no display face. If `next/font` reports the axes as
  unavailable, load static weights 400/500/600.
  - Fallback stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- **Numerals:** every element that renders money, counts, dates in tables or percentages gets
  `font-variant-numeric: tabular-nums` (utility `tabular-nums`). The `MoneyAmount` component applies it itself.
  Hero amounts also use `font-feature-settings: "zero" 0` (no slashed zero; it reads as code).
- **Scale** (rem at 16px root; mobile and desktop share the scale, only hero sizes step up at `md`):

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `text-xs` | 12 / 16 | 500 | Badges, chart axis, captions. Never body copy. |
| `text-sm` | 14 / 20 | 400 | Secondary lines in rows, helper text, table cells on desktop |
| `text-base` | 16 / 24 | 400 | Body, inputs (16px min on mobile to stop iOS zoom), row titles |
| `text-lg` | 18 / 26 | 600 | Section titles, sheet titles |
| `text-xl` | 20 / 28 | 600 | Page titles (mobile) |
| `text-2xl` | 24 / 32 | 600 | Page titles (desktop), card headline numbers |
| `text-money-hero` | 36 / 40 (md: 44 / 48) | 600, tracking −0.02em | One hero number per screen |

- Row amounts: 16px weight 500. Totals in day headers: 14px weight 500, muted.
- Hero amounts: cents rendered at 60% size in muted colour (home and net worth only; never in lists).
- Max line length for prose (insights, help): 68ch.
- Case: sentence case everywhere. No uppercase labels except optional 12px overlines with +0.04em tracking.

### 2.2 Colour model

Colours are OKLCH. Neutrals carry an almost invisible cool tint (hue 260, chroma ≤ 0.012) so they sit with any
brand hue. Values below are targets; CI must verify the pairs listed in §7 with a contrast checker
(e.g. a small Vitest test using `culori` + `wcag-contrast` over the token file).

**Brand-driven primary.** Config provides one colour (`brand.primary`, any CSS colour). At config load the
server converts it to OKLCH and derives per mode:

| Derived token | Light mode | Dark mode |
|---|---|---|
| `--primary` | brand hue, L clamped to 0.42–0.58, C capped at 0.19 | same hue, L clamped to 0.68–0.80, C capped at 0.16 |
| `--primary-foreground` | white or `oklch(0.18 0.01 260)`, whichever has the higher contrast (must reach 4.5:1) | same rule |
| `--primary-soft` | `color-mix(in oklch, var(--primary) 12%, var(--surface))` | 18% |
| `--ring` | `--primary` (guaranteed ≥ 3:1 vs background by the clamp) | same |

The clamp is what makes "any reasonable primary" work: a neon yellow brand becomes a usable olive-gold in light
mode, a navy brand becomes a readable periwinkle in dark mode, hue preserved. The raw brand colour is still used
unmodified for the logo only. The settings branding preview (§5.7) shows the derived values and contrast ratios.

Primary is for **interactive emphasis only**: primary buttons, active nav item, focus ring, selected chip,
links, the progress fill of a budget line that is on track. It never carries money meaning.

### 2.3 Token block (Tailwind v4 / shadcn compatible)

Put this in `apps/web/app/globals.css`. Brand values are injected by the root layout as an inline `<style>` with
the derived `--primary*` values for `:root` and `.dark`; the values below are the defaults when no brand is set
(a calm deep teal).

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  color-scheme: light;

  /* Brand (overridden at runtime from installation config) */
  --primary: oklch(0.489 0.078 215.4);
  --primary-foreground: oklch(0.99 0 0);
  --primary-soft: color-mix(in oklch, var(--primary) 12%, var(--surface));

  /* Surfaces */
  --background: oklch(0.985 0.002 260);   /* app canvas */
  --surface: oklch(1 0 0);                 /* cards, sheets, rows */
  --surface-2: oklch(0.965 0.003 260);     /* subtle fills, hover, table header, skeleton base */
  --surface-3: oklch(0.935 0.004 260);     /* pressed, selected neutral */
  --overlay: oklch(0.15 0.01 260 / 0.45);  /* sheet/dialog scrim */

  /* Lines */
  --border: oklch(0.91 0.004 260);         /* dividers, card outlines (decorative) */
  --input: oklch(0.66 0.008 260);          /* form control borders, ≥3:1 vs surface */

  /* Text */
  --foreground: oklch(0.21 0.01 260);
  --muted-foreground: oklch(0.50 0.012 260); /* ≥4.5:1 on surface-2 */
  --subtle-foreground: oklch(0.62 0.01 260); /* placeholders, disabled; never essential info */

  /* Semantic */
  --positive: oklch(0.52 0.13 150);        /* income, under budget, synced */
  --positive-soft: oklch(0.96 0.03 150);
  --negative: oklch(0.53 0.19 27);         /* over budget, negative balance, errors */
  --negative-soft: oklch(0.96 0.025 27);
  --warning: oklch(0.54 0.13 70);          /* near limit, consent expiring, needs review */
  --warning-soft: oklch(0.96 0.04 85);
  --transfer: oklch(0.50 0.05 250);        /* internal transfers, neutral movements */
  --transfer-soft: oklch(0.955 0.012 250);
  --destructive: var(--negative);
  --destructive-foreground: oklch(0.99 0 0);
  --ring: var(--primary);

  /* Charts: categorical, fixed order, ≥3:1 vs surface */
  --chart-1: oklch(0.56 0.15 255);  /* blue */
  --chart-2: oklch(0.60 0.11 190);  /* teal */
  --chart-3: oklch(0.64 0.14 70);   /* amber */
  --chart-4: oklch(0.54 0.17 305);  /* violet */
  --chart-5: oklch(0.58 0.17 5);    /* rose */
  --chart-6: oklch(0.58 0.13 145);  /* green */
  --chart-7: oklch(0.60 0.16 45);   /* orange */
  --chart-8: oklch(0.55 0.03 260);  /* slate, reserved for "Outros"/uncategorised */

  /* Shape, depth, motion */
  --radius: 0.625rem;  /* 10px */
  --shadow-sm: 0 1px 2px oklch(0.2 0.01 260 / 0.06);
  --shadow-md: 0 4px 12px oklch(0.2 0.01 260 / 0.08), 0 1px 3px oklch(0.2 0.01 260 / 0.06);
  --shadow-lg: 0 12px 32px oklch(0.2 0.01 260 / 0.12), 0 2px 6px oklch(0.2 0.01 260 / 0.06);
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --duration-fast: 120ms;
  --duration-base: 180ms;
  --duration-slow: 260ms;

  /* Layout */
  --tabbar-height: 64px;
  --topbar-height: 56px;
  --sidebar-width: 248px;
  --sidebar-width-collapsed: 72px;
}

.dark {
  color-scheme: dark;

  --primary: oklch(0.68 0.078 215.4);
  --primary-foreground: oklch(0.18 0.01 260);
  --primary-soft: color-mix(in oklch, var(--primary) 18%, var(--surface));

  --background: oklch(0.16 0.005 260);
  --surface: oklch(0.20 0.006 260);
  --surface-2: oklch(0.24 0.007 260);
  --surface-3: oklch(0.28 0.008 260);
  --overlay: oklch(0.05 0 0 / 0.6);

  --border: oklch(0.30 0.008 260);
  --input: oklch(0.52 0.01 260);

  --foreground: oklch(0.96 0.003 260);
  --muted-foreground: oklch(0.72 0.01 260);
  --subtle-foreground: oklch(0.58 0.01 260);

  --positive: oklch(0.76 0.14 150);
  --positive-soft: oklch(0.28 0.05 150);
  --negative: oklch(0.72 0.16 25);
  --negative-soft: oklch(0.28 0.06 25);
  --warning: oklch(0.80 0.13 80);
  --warning-soft: oklch(0.30 0.05 80);
  --transfer: oklch(0.74 0.05 250);
  --transfer-soft: oklch(0.27 0.02 250);
  --destructive-foreground: oklch(0.18 0.01 260);

  --chart-1: oklch(0.72 0.13 255);
  --chart-2: oklch(0.74 0.10 190);
  --chart-3: oklch(0.80 0.13 75);
  --chart-4: oklch(0.72 0.14 305);
  --chart-5: oklch(0.72 0.15 5);
  --chart-6: oklch(0.74 0.13 145);
  --chart-7: oklch(0.75 0.14 45);
  --chart-8: oklch(0.66 0.02 260);

  --shadow-sm: 0 1px 2px oklch(0 0 0 / 0.4);
  --shadow-md: 0 4px 12px oklch(0 0 0 / 0.45);
  --shadow-lg: 0 12px 32px oklch(0 0 0 / 0.55);
}

@theme inline {
  --font-sans: var(--font-plex), ui-sans-serif, system-ui, sans-serif;

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-surface-3: var(--surface-3);
  --color-overlay: var(--overlay);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-muted-foreground: var(--muted-foreground);
  --color-subtle-foreground: var(--subtle-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary-soft: var(--primary-soft);
  --color-positive: var(--positive);
  --color-positive-soft: var(--positive-soft);
  --color-negative: var(--negative);
  --color-negative-soft: var(--negative-soft);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --color-transfer: var(--transfer);
  --color-transfer-soft: var(--transfer-soft);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-chart-6: var(--chart-6);
  --color-chart-7: var(--chart-7);
  --color-chart-8: var(--chart-8);

  /* shadcn aliases so generated components work unmodified */
  --color-card: var(--surface);
  --color-card-foreground: var(--foreground);
  --color-popover: var(--surface);
  --color-popover-foreground: var(--foreground);
  --color-muted: var(--surface-2);
  --color-accent: var(--surface-2);
  --color-accent-foreground: var(--foreground);
  --color-secondary: var(--surface-2);
  --color-secondary-foreground: var(--foreground);

  --radius-sm: calc(var(--radius) - 4px);  /* 6px: badges, chips */
  --radius-md: calc(var(--radius) - 2px);  /* 8px: inputs, buttons */
  --radius-lg: var(--radius);              /* 10px: cards, rows groups */
  --radius-xl: calc(var(--radius) + 6px);  /* 16px: sheets, dialogs */

  --shadow-sm: var(--shadow-sm);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);

  --ease-out: var(--ease-out);
  --ease-in: var(--ease-in);
}

@layer base {
  * { @apply border-border; }
  html { -webkit-text-size-adjust: 100%; scroll-padding-top: calc(var(--topbar-height) + 8px);
         scroll-padding-bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom) + 8px); }
  body { @apply bg-background text-foreground font-sans antialiased; }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important;
                           transition-duration: 1ms !important; scroll-behavior: auto !important; }
}
```

Theme switching: `next-themes` with `attribute="class"`, options System / Claro / Escuro, stored per user.
Set `<meta name="theme-color">` for both schemes to `--background` values. Never use pure black or pure white
as the dark/light canvas.

### 2.4 Spacing

4px base, Tailwind default scale. Use only these steps in layouts: 1 (4), 2 (8), 3 (12), 4 (16), 5 (20),
6 (24), 8 (32), 10 (40), 12 (48), 16 (64).

- Page gutter: 16px mobile, 24px tablet, 32px desktop. Max content width 1200px; reading views 720px.
- Section gap: 24px mobile, 32px desktop. Card padding: 16px mobile, 20px desktop.
- List rows: min height 56px (two-line) / 48px (one-line), horizontal padding 16px, 12px gap between leading
  icon and text. Desktop dense table rows: 44px.
- Gap between adjacent tap targets: ≥ 8px.

### 2.5 Radius and elevation

- Radius: 6 (chips, badges), 8 (inputs, buttons), 10 (cards, grouped lists), 16 (sheet top corners, dialogs),
  full (avatars, category icon discs, toggle pills).
- Elevation is mostly **borders, not shadows**. Cards: `bg-surface border` with no shadow. Shadows only for things
  that float: popovers and dropdowns (`shadow-md`), sheets, dialogs and toasts (`shadow-lg`), sticky bars on
  scroll (`shadow-sm`, added only once content is under them).

### 2.6 Motion

| Use | Duration | Easing |
|---|---|---|
| Hover, press, colour change | 120ms | ease-out |
| Chip select, toggles, accordion | 180ms | ease-out |
| Sheet / dialog enter | 260ms | ease-out (slide + fade) |
| Sheet / dialog exit | 180ms | ease-in |
| Row removed from review inbox | 180ms height collapse + fade | ease-out |
| Number change (hero amounts) | none: swap instantly; no counting tickers | — |

Animate transform and opacity only (height collapse via `grid-template-rows: 0fr`). No page transitions, no
parallax, no bouncing. Reduced motion: everything collapses to instant; sheets fade only.

---

## 3. Money formatting

All formatting goes through one function in `packages/core` (e.g. `formatMoney(minor: bigint, currency, locale,
opts)`) built on `Intl.NumberFormat`. Components never format money by hand.

### 3.1 Rules

| Case | pt-PT | en | Colour | Notes |
|---|---|---|---|---|
| Expense | `−45,20 €` | `−€45.20` | `foreground` | U+2212 minus, not hyphen |
| Income | `+1 850,00 €` | `+€1,850.00` | `positive` | explicit plus |
| Transfer (household view) | `250,00 €` + ⇄ icon | `€250.00` + ⇄ | `transfer` | no sign: not spending or income |
| Transfer (inside one account) | `−250,00 €` + ⇄ | `−€250.00` + ⇄ | `transfer` | sign shows effect on that account |
| Pending | as above | as above | `muted-foreground` | clock icon + "Pendente" label; excluded from totals |
| Balance (positive) | `3 412,08 €` | `€3,412.08` | `foreground` | no plus sign on balances |
| Balance (negative) | `−120,40 €` | `−€120.40` | `negative` | |
| Zero | `0,00 €` | `€0.00` | `muted-foreground` | |
| Chart axis / compact | `1,2 mil €` | `€1.2K` | — | `notation: "compact"`, max 1 decimal |
| Budget remaining over | `−86,50 €` "acima" | `−€86.50` "over" | `negative` | word plus colour |

### 3.2 Implementation notes (load-bearing)

- **pt-PT does not group 4-digit numbers by default.** CLDR sets `minimumGroupingDigits = 2` for `pt-PT`, so
  `Intl` outputs `1234,56 €`. Pass `useGrouping: "always"` to get `1 234,56 €` consistently (also matches the
  household's spreadsheet). Verify with a unit test on Node 22.
- Use whatever separator characters `Intl` emits (pt-PT uses non-breaking spaces between groups and before `€`).
  Never `.replace()` them; assertions in tests should normalise whitespace.
- Signs: format the absolute value with `signDisplay: "never"`, then prepend U+2212 `−` or `+` per the table, so
  the sign is controlled by meaning (expense/income/transfer), not just arithmetic.
- Always 2 decimals for EUR (`minimumFractionDigits` from the currency). Non-EUR amounts show the ISO code when
  ambiguous (`120,00 USD`), and never get converted (spec non-goal).
- Store and pass integer minor units (`bigint` or safe integer); convert to number only at format time.
- Dates: `Intl.DateTimeFormat`. Day headers: "Hoje", "Ontem", then `seg., 14 out.`; older than the current
  year adds the year. Tables use `14/10/2026` (pt-PT) or `14 Oct 2026` (en).
- Screen readers: `MoneyAmount` renders a visually hidden prefix with the meaning ("Despesa", "Receita",
  "Transferência", "Pendente") because the minus/plus glyph and colour alone are not reliable.

---

## 4. Information architecture and navigation

### 4.1 Top-level sections (all phases)

| Section (pt-PT / en) | Route | Phase | Mobile tab bar | Desktop sidebar |
|---|---|---|---|---|
| Início / Home | `/` | 0 (simple), 5 (dashboard) | Tab 1 | yes |
| Movimentos / Transactions | `/transactions` (+ `/transactions/review`) | 1 | Tab 2, review badge | yes, review count |
| Orçamento / Budget | `/budget` | 3 | Tab 3 | yes |
| Património / Net worth | `/net-worth` | 4 | Tab 4 | yes |
| Contas e ligações / Accounts & connections | `/accounts`, `/connections` | 1, 2 | in "Mais" (tab 3 until Phase 3) | yes |
| Análises / Insights | `/insights` | 7 | in "Mais" | yes |
| Definições / Settings | `/settings/*` | 0 | in "Mais" | bottom of sidebar |

Mobile tab bar, final shape: **Início · Movimentos · Orçamento · Património · Mais**. "Mais" opens a full page
listing Contas e ligações, Análises, Definições, household switcher, theme, sign out.

Phase 0–1 tab bar (sections that don't exist yet are hidden, never shown disabled):
**Início · Movimentos · Contas · Definições**. When Budget ships, Contas moves into "Mais".

### 4.2 Mobile shell (< 768px)

- **Top bar** (56px, sticky): page title left (20px/600), up to two icon actions right (search, add). On detail
  pages: back chevron + title. Background `background`, gains `shadow-sm` + border once scrolled.
- **Bottom tab bar** (64px + `env(safe-area-inset-bottom)`, fixed): `<nav aria-label="Principal">`, each tab icon
  (24px lucide) above 12px label, whole cell is the target (≥ 64×56). Active: primary icon and label + 3px pill
  indicator behind icon in `primary-soft`. Inactive: `muted-foreground`. Review badge on Movimentos: count up to
  99 ("99+"), `warning` background. Hidden while the on-screen keyboard is open and in full-screen flows (import,
  setup, auth).
- Bottom sheets (Drawer) for pickers, detail and forms under ~6 fields; full pages for wizards.
- No floating action button. "Add" lives in the top bar of the relevant section.

### 4.3 Tablet (768–1023px) and desktop (≥ 1024px)

- 768–1023: icon rail sidebar (72px) with tooltips; top bar per page.
- ≥ 1024: full sidebar (248px), collapsible to the rail (state persisted). Contents, top to bottom: brand logo
  + product name (from config), household switcher (only if the user has >1 household), nav items with icons and
  counts, spacer, Definições, user menu (avatar, name, theme, language, sign out).
- Content uses a 12-column grid inside max 1200px. Detail views open in a **right side sheet** (480px) over
  lists instead of navigating away, so the list position is kept. Routes are still deep-linkable
  (`/transactions/[id]` via intercepting route renders the sheet; direct load renders a full page).
- Keyboard: `/` focuses search, `j`/`k` move through list rows, `c` opens category picker on focused row,
  `Esc` closes sheets. Shortcuts listed in a `?` dialog; none are required for any task.

### 4.4 Global states in the shell

- **Offline** (PWA): slim banner under top bar, `warning-soft`: "Sem ligação. A mostrar os últimos dados
  guardados." Writes are disabled with a tooltip, not queued (Phase 5 may revisit).
- **Sync problem** (Phase 2+): persistent `negative-soft` banner on Home and Contas when any connection has
  failed or consent expired: "A ligação ao banco expirou. Renovar acesso".
- **Session expired**: redirect to sign-in with return URL and the notice "A sessão terminou. Inicie sessão
  novamente."

### 4.5 Copy tone

- pt-PT, impersonal and short; avoid "tu"/"você" where an infinitive works ("Rever movimentos", "Adicionar
  conta"). When address is unavoidable, use the formal-neutral third person ("Inicie sessão").
- Plain words over finance jargon: "Movimentos", "Saldo", "Por rever", "Transferência entre contas".
- Numbers in copy are formatted with `formatMoney`; never "EUR 45.2".
- Errors say what happened and what to do: "Não foi possível importar a linha 14: data inválida (31/02/2026)."
- No exclamation marks, no celebration copy, no emoji.

---

## 5. Screen specs (Phase 0–1)

Every data screen implements four states. **Loading**: skeletons that match the final layout (same row
heights), shown only after 200ms to avoid flashes. **Empty**: one sentence explaining why it's empty + one
primary action. **Error**: inline `Alert` in place of content with what failed and a "Tentar novamente" button;
never a blank screen. **Success/partial**: content, with stale-data hints where relevant.

### 5.1 Sign-in (`/sign-in`)

- Centered column, max 400px, vertically centred on desktop, top-aligned with 48px top padding on mobile.
  Brand logo (config, max 48px tall) + product name; below, form in a `surface` card on desktop, flat on mobile.
- Fields: Email (`type=email`, `autocomplete=username`), Palavra-passe (`autocomplete=current-password`, show/hide
  toggle button with `aria-pressed`). Primary button "Entrar", full width, 48px.
- Paste and password managers always allowed (WCAG 3.3.8). No CAPTCHA puzzles.
- States: submitting (button spinner + "A entrar…", fields read-only); invalid credentials (single message above
  the form, `role=alert`: "Email ou palavra-passe incorretos." — never say which); rate-limited/locked ("Demasiadas
  tentativas. Tente novamente dentro de 14 minutos." with live countdown); network error.
- No sign-up link (no public sign-up). Footer: language switch (PT / EN), support email from config.

### 5.2 2FA challenge and setup

**Challenge** (after password): title "Verificação em dois passos", text "Introduza o código de 6 dígitos da
aplicação de autenticação." `InputOTP` with 6 slots, `inputmode=numeric`, `autocomplete=one-time-code`, paste
fills all slots, auto-submits on 6th digit. Checkbox "Confiar neste dispositivo durante 30 dias" (if Better Auth
config allows). Link "Usar um código de recuperação" swaps to a single text field. Error: slots get `negative`
border, message "Código incorreto. Os códigos mudam a cada 30 segundos." and the field clears and refocuses.

**Setup** (forced for owners right after first sign-in or setup; reachable from Settings › Segurança for others).
Three-step full page with a step indicator ("Passo 1 de 3"):
1. *Ler o código*: QR code (200px, white tile even in dark mode for scanner contrast), below it the secret as
   grouped text (`ABCD EFGH …`) with a copy button, for phones where scanning the same device is impossible.
2. *Confirmar*: `InputOTP` as above.
3. *Códigos de recuperação*: 10 codes in a two-column `tabular-nums` grid; buttons "Copiar" and "Descarregar
   .txt"; checkbox "Guardei os códigos num local seguro" enables "Concluir". Leaving this step warns.

### 5.3 First-run setup (`/setup?token=…`)

Note: spec §7.2 says the first owner is created by `pnpm admin:create-owner`. This screen is the alternative
asked for in the brief (a one-time setup token printed by the CLI/installer). Build whichever the plan picks;
if both, the CLI prints the URL.

- Full-page wizard, max 520px, progress "Passo n de 3". Token field prefilled from URL and hidden when valid.
- Step 1 *Agregado familiar*: Nome do agregado (e.g. "Casa Exemplo"), Moeda (Select, default EUR), Início do ano
  orçamental (month Select, default Janeiro, helper "O orçamento anual começa neste mês."), Idioma, Fuso horário
  (default from browser, searchable Combobox).
- Step 2 *A sua conta*: Nome, Email, Palavra-passe (strength hint text, min length stated up front, not after
  failure), Confirmar palavra-passe.
- Step 3: 2FA setup (§5.2), then land on Home empty state.
- States: token invalid/expired/used → full-page message "Este link de configuração já não é válido." with
  instructions to generate a new one via the CLI; validation errors inline under each field; submit failure keeps
  all entered values.

### 5.4 Invite accept (`/invite/[token]`)

- Card: "{Inviter} convidou-o para o agregado **{Household}** como {role}." Role explained in one line
  (owner: "pode gerir tudo"; member: "pode ver e editar movimentos e orçamento"; viewer: "só pode ver").
- Not signed in, no account: Nome, Email (prefilled, read-only), Palavra-passe → "Aceitar e criar conta" → 2FA
  setup if role is owner (recommended screen otherwise, skippable with "Mais tarde").
- Already has an account: "Entrar para aceitar" → sign-in → accept confirmation.
- Signed in as a different email: explain and offer "Terminar sessão e continuar".
- States: expired ("Este convite expirou. Peça um novo a {inviter}."), already used, revoked; all full-page,
  calm, with no form.

### 5.5 App shell

Per §4. Root layout reads installation config server-side and injects: product name (`<title>` template
"{page} · {product}"), logo URLs (light and dark variants; fall back to the plumb mark on a tile in `primary`, never an
initial), derived `--primary*` tokens, manifest values (name, short_name, theme colour, icons). PWA icons
are generated at runtime from the configured name and colour (`BRAND_LOGO_URL` drives the UI only). Skip link "Saltar para o conteúdo" as first focusable element.

### 5.6 Home, Phase 0–1 version (`/`)

Until the dashboard (Phase 5), Home is a compact status page, not an empty canvas:
1. **Review prompt** (if count > 0): full-width card, `warning-soft` left accent bar 3px: "7 movimentos por rever"
   + "Rever" button → review inbox. Hidden when 0.
2. **Este mês**: two figures side by side: Saídas `−2 140,30 €`, Entradas `+3 850,00 €` (transfers excluded,
   pending excluded, note "Excluindo transferências entre contas" as caption).
3. **Contas**: up to 5 accounts with balances (AccountBadge rows), "Ver todas".
4. **Últimos movimentos**: 5 rows, "Ver todos".
- Empty (no accounts): illustration-free card, "Ainda não há contas. Comece por adicionar uma conta ou importar um
  extrato." Buttons "Adicionar conta" (primary) and "Importar CSV" (secondary).

### 5.7 Settings (`/settings`)

Mobile: list page of sections → each a sub-page. Desktop: left sub-nav (200px) + form column (max 640px).
Forms save per section with an explicit "Guardar" button (sticky at the bottom on mobile when dirty), dirty-state
guard on navigation, success toast "Alterações guardadas".

- **Agregado** (owners edit, others read-only): name, currency, fiscal-year start month, locale, timezone,
  emergency-fund months (number stepper), hub account (Select of accounts, optional, helper explains the transfer
  plan), AI features Switch with a plain explanation of exactly what is sent ("descrição, valor, data e tipo de
  conta; nunca nomes ou IBAN").
- **Membros**: list rows (Avatar, name, email, role Select for owners, "Você" tag on self). Last owner cannot be
  demoted/removed (control disabled with reason). "Convidar membro" → sheet: email + role → result shows the
  link with copy button when SMTP is not configured ("O email não está configurado. Partilhe este link:").
  Pending invites section: email, role, expiry, actions Copiar link / Revogar (AlertDialog to confirm revoke).
- **Marca e aspeto** (installation-level; editable only if config is DB-backed and user is installation admin,
  otherwise read-only with "Definido na configuração do servidor"): product name, logo upload (light/dark, SVG or
  PNG, preview on both backgrounds), primary colour (hex input + native colour input). **Live preview** panel:
  side-by-side light and dark mini-shell (sidebar item active, primary button, focus ring, a chip, a budget bar)
  using the derived tokens, with the derived hex values and their contrast ratios shown as text
  ("Texto do botão 5,8:1 · Contorno de foco 3,4:1"). If the clamp changed the colour, say so: "A cor foi ajustada
  para garantir contraste no modo escuro."
- **Segurança**: change password, 2FA status (enable/regenerate recovery codes), active sessions list with
  "Terminar" per session.
- **Preferências** (per user): language, theme (System/Claro/Escuro ToggleGroup), number format (see Open
  questions).
- **Categorias e regras** (Phase 1): category groups and categories (name, icon from a curated lucide set,
  colour slot 1–8), drag-free reordering via up/down buttons; rules list ordered, each with plain-language summary
  ("Se a descrição contém 'CONTINENTE' → Supermercado").

### 5.8 Accounts list (`/accounts`)

- Header: title "Contas", action "Adicionar". Summary line under the title: "Saldo disponível 8 412,30 €"
  (checking + savings + meal benefit, `include_in_net_worth`, excluding cards and loans; caption states it).
- Grouped list by type, group header with subtotal right-aligned: Contas à ordem, Poupança, Cartões, Subsídio de
  refeição, Investimento, Numerário, Empréstimos, Outras. Archived accounts in a collapsed "Arquivadas" group.
- Row (64px): institution logo or monogram disc (40px), name (16/500), second line: owners ("Alex · Sam") and
  freshness ("Atualizado há 2 h" / "Importado a 12 out." / "Manual"), trailing balance MoneyAmount. Phase 2 adds
  SyncStatus dot on the logo.
- Tap → account detail: balance hero, mini balance chart (Phase 5), its transactions list (same component as
  §5.9 pre-filtered), actions: Editar, Importar extrato, Arquivar.
- Add/edit account sheet: Nome, Tipo (RadioGroup cards with icon), Instituição (searchable Combobox, optional),
  Moeda, Saldo inicial + data, Titulares (multi-select members), switches "Incluir no orçamento" and "Incluir no
  património". Validation inline.
- Empty: "Ainda não há contas." + Adicionar conta / Importar CSV. Error: Alert + retry.

### 5.9 Transactions list (`/transactions`)

**Mobile layout**, top to bottom:
1. Top bar: "Movimentos", actions Search (expands into a full-width search field with cancel) and Add (menu:
   "Movimento manual", "Importar extrato").
2. **Review banner** when count > 0: compact row "7 por rever" with warning dot and chevron → `/transactions/review`.
3. **Filter bar**: horizontally scrollable chips (no wrap): Período (default "Este mês"), Conta, Categoria, Tipo
   (Despesas / Receitas / Transferências), Estado (Pendentes / Por rever / Sem categoria). Active chips filled with
   `primary-soft` + label showing the value ("Conta: Conta Conjunta"), × to clear; "Limpar" chip when ≥ 2
   active. Each chip opens a bottom sheet with the options. Filters live in the URL query string.
4. **Period summary** (only when filters are applied or period ≠ current month): "42 movimentos · Saídas
   −1 230,40 € · Entradas +2 000,00 €".
5. **Day groups**: sticky day header (32px, `surface-2`, 14px/500): "Hoje" left, day net total right (muted;
   transfers excluded). Rows inside a single bordered group per day.
6. **TransactionRow** (min 56px): CategoryIcon disc 36px (category colour soft bg + icon; uncategorised = dashed
   outline + `?` icon), title = merchant/counterparty clean name (1 line, truncate), subtitle = category name ·
   account short name (14px muted, 1 line). Trailing MoneyAmount. Indicators before amount: clock (pending),
   ⇄ (transfer), 8px `warning` dot (needs review). Whole row is a button.
7. Infinite scroll with virtualisation (TanStack Virtual), 50 per page, "A carregar mais…" row skeleton; "Fim dos
   movimentos deste período" terminal text.

**Desktop layout**: same filters as a toolbar row (search input 320px left, filter popovers, "Limpar"), then a
table: checkbox · Data · Descrição (merchant + raw description muted on hover tooltip) · Categoria (inline
Combobox CategoryChip, edit in place) · Conta (AccountBadge) · Valor (right-aligned). Day grouping kept as
sticky group rows. Multi-select shows a bulk action bar: "3 selecionados · Categorizar · Marcar como
transferência · Exportar". Clicking a row opens the right detail sheet.

**Search**: matches counterparty, raw description, notes, amount ("45,20" or "45.20"); debounced 250ms; results
keep day grouping; highlight match in title.

**States**: loading = 3 day headers × 4 skeleton rows; empty month = "Sem movimentos em outubro." + "Importar
extrato"; empty search = "Nenhum movimento corresponde a 'xyz'." + "Limpar pesquisa"; empty with filters = list
active filters + "Limpar filtros"; error = Alert + retry, keep filters.

### 5.10 Transaction detail and categorise sheet

**Detail** (bottom sheet on mobile at 90% height with drag handle; right sheet on desktop):
- Header: CategoryIcon 48px, merchant name (18/600), MoneyAmount hero 32px with meaning label above
  ("Despesa", "Receita", "Transferência", "Pendente").
- Field list (label left muted, value right): Data (booking; value date if different), Conta, Estado
  (Pendente/Contabilizado), Categoria (CategoryChip, tap → picker), Origem da categoria ("Regra: Supermercados",
  "Memória do comerciante", "IA · 62% de confiança", "Alex, 14 out."), Descrição original (raw text, selectable,
  14px), Notas (textarea, autosave on blur with "Guardado" inline confirmation), Origem (Banco / Importado de
  extrato_out.csv / Manual).
- Transfer block if linked: "Transferência para Conta Conjunta" with the paired movement as a mini row; action
  "Não é uma transferência". If not linked: "Marcar como transferência" → pick the counterpart from suggested
  matches.
- Footer actions: Editar and Eliminar only for `manual` / `import` sources (Eliminar via AlertDialog). Split is
  later.

**Category picker** (the most-used control in the app):
- Opens as its own bottom sheet (mobile) or popover Command (desktop, 360px).
- Top: **Suggestions** row of up to 3 large chips (44px tall): AI/memory suggestion first with a small confidence
  label, then the 2 most-used categories for this merchant or account. One tap applies.
- Search field (autofocus on desktop only; on mobile focusing would raise the keyboard and hide the grid).
- Grid grouped by category group: group label, then chips in a 2-column (mobile) / 1-column list (desktop
  Command) layout, each with icon + name. Recently used group first.
- **One tap applies and closes.** Optimistic update; toast with "Anular" for 6s ("Categorizado como
  Supermercado · Anular"). Under the suggestions, a Checkbox "Aplicar sempre a CONTINENTE" (off by default) that
  creates a rule on apply; after 3 identical manual corrections for a merchant, it is pre-checked and labelled
  "Sugerido".
- In review mode the sheet advances to the next item instead of closing (see §5.12).

### 5.11 CSV import wizard (`/import`)

Full-page flow with step indicator (Stepper: Carregar · Colunas · Pré-visualizar · Confirmar). Back keeps state.
Max content 960px; on mobile tables become row cards.

1. **Carregar**: choose account (Select; "Criar nova conta" option), drop zone + file button ("Escolher ficheiro";
   accepts .csv, .ofx, .qif, .xlsx; max size stated). After upload: detected encoding, delimiter, decimal
   separator, date format and a matched preset ("Formato reconhecido: Banco PT — extrato CSV"). OFX/QIF skip step 2.
2. **Colunas**: for each required target (Data, Descrição, Valor *or* Débito + Crédito, optional Saldo, Data valor,
   Referência) a Select listing the file's columns with a sample value ("Coluna C · ex.: 14-10-2026"). Toggle
   "O valor vem em duas colunas (débito/crédito)". Overrides for date format and decimal separator. Live preview
   of the first 5 parsed rows below, invalid cells highlighted with `negative` text and reason. "Guardar como
   formato para {institution}" checkbox. No drag-and-drop mapping.
3. **Pré-visualizar**: summary counters in a row: Novos 182 · Duplicados 14 (serão ignorados) · Transferências
   detetadas 9 · Com erros 2. Tabs filter the table by those groups. Error rows list row number and reason; option
   "Ignorar linhas com erros". Date range of the import and the resulting balance vs the file's last balance if
   present ("Saldo final no ficheiro 2 310,40 € · calculado 2 310,40 €" with ✓ or a warning when different).
4. **Confirmar**: primary button "Importar 182 movimentos". Progress state while running (no cancel after start).
   Result: "182 movimentos importados. 31 precisam de revisão." Buttons "Rever agora" and "Ver movimentos".
   Import is recorded so the user can "Desfazer importação" from the account page for 24h (if feasible; else open
   question).
- Errors: unreadable file ("Não foi possível ler o ficheiro. Confirme que é um CSV exportado do banco."), no rows,
  all duplicates ("Todos os movimentos deste ficheiro já existem.").

### 5.12 Review inbox (`/transactions/review`)

- Reached from the badge, Home card and banner. Title "Por rever" + count. Explanation line once, dismissible:
  "Movimentos que a aplicação não conseguiu classificar com confiança."
- Tabs (segmented, only shown when non-empty): Categoria · Transferências · Todos.
- **Review card row** (mobile, min 88px): merchant, date · account, amount on the first line; second line shows
  the reason ("Confiança baixa" / "Sem categoria" / "Possível transferência") and the suggestion as a
  CategoryChip. Two buttons, 44px each, right-aligned: ✓ "Confirmar" (accepts suggestion) and "Alterar" (opens
  picker). For transfer candidates: shows both legs and buttons "É transferência" / "Não é".
- On confirm the row collapses (180ms) and focus moves to the next row's primary button; toast with "Anular".
- Picker in review mode advances to the next item; header shows "3 de 7".
- Desktop: table with checkboxes and bulk "Confirmar sugestões selecionadas"; keyboard `y` confirm, `c` change.
- Empty (done): calm completion, no confetti: check icon in `positive`, "Tudo revisto." and "Voltar aos
  movimentos". The tab bar badge disappears.

---

## 6. Later screens (direction only)

- **Home dashboard (Phase 5)**: the 10-second answer. Top: one status sentence with icon + colour + word
  ("Dentro do plano" / "Atenção: 2 rubricas acima" / "Acima do plano"), then hero "Restam 1 240,00 € de
  3 800,00 €" with a single BudgetProgressBar including a **pace marker** (today's position in the month). Below:
  lines over or near budget (max 3), review count, sync health summary, net-worth sparkline with MoM change,
  upcoming recurring payments (next 7 days). Each block links to its section. No grid of identical stat cards.
- **Budget month (Phase 3)**: month stepper (‹ outubro 2026 ›), unallocated summary ("Por atribuir 120,00 €",
  negative in `negative`), sections Receitas / Despesas / Poupança, each line a row with name, BudgetProgressBar,
  "312,40 € de 400,00 €" and remaining. Group subtotals collapsible. Transfer plan card: hub → accounts amounts,
  negative remainder flagged in `negative` with explanation.
- **Budget year grid (Phase 3)**: desktop table with sticky first column (line name) and sticky header (months
  from fiscal start), cells show actual with planned on hover/second line, variance tint (`positive-soft` under,
  `negative-soft` over, only when month closed or > pace). Mobile: horizontal scroll with sticky name column
  (min cell 88px) plus a "por rubrica" alternative view: pick a line, see 12 months as a vertical list.
- **Net worth (Phase 4)**: hero total + MoM change (word + arrow + colour), line/area chart 12/24 months, then
  Ativos and Passivos lists grouped by kind with values and last valuation date; "Atualizar valor" per manual asset.
- **Connections (Phase 2)**: list per connection: institution, accounts covered, SyncStatus with "Última
  sincronização há 3 h", consent expiry ("Acesso expira em 6 dias" in `warning` within 7 days), actions
  "Atualizar agora" (disabled with reason "Próxima atualização possível às 14:00" when PSD2 limit reached) and
  "Renovar acesso". Detail: `sync_run` history table (time, new, updated, errors).
- **Insights (Phase 7)**: list of monthly reports (date, 1-line summary); report view is a Read-mode page (720px,
  16–18px prose, numbers via MoneyAmount, links to the transactions behind each finding). Anomaly cards with
  "Ver movimentos" action. AI-off households see an explanation and the switch location, not a teaser.

---

## 7. Component inventory

### 7.1 shadcn/ui components used

| Need | shadcn/ui component | Notes |
|---|---|---|
| Buttons | `Button` | Variants: default (primary), secondary (`surface-2`), outline, ghost, destructive, link. Sizes: sm 36px (desktop only), default 44px, lg 48px. Loading state = spinner + label, `aria-busy`. |
| Forms | `Form`, `Input`, `Label`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup` | Visible labels always; helper text below; error text below field with icon, linked via `aria-describedby`. |
| Combobox / pickers | `Command` + `Popover` | Account, institution, timezone, category (desktop). |
| OTP | `InputOTP` | 2FA. |
| Mobile sheets | `Drawer` (vaul) | Filters, category picker, detail, small forms. |
| Desktop side panels | `Sheet` (side right) | Detail, add/edit forms. |
| Dialogs | `Dialog`, `AlertDialog` | AlertDialog only for destructive or irreversible actions. |
| Navigation | `Sidebar` (shadcn sidebar block), `Tabs`, `Breadcrumb` (desktop settings) | Tab bar is custom (below). |
| Lists/tables | `Table` + TanStack Table (`DataTable` pattern) | Desktop transactions, import preview, year grid. |
| Feedback | `Sonner` (toast), `Alert`, `Skeleton`, `Progress` (import only) | Toasts bottom-center on mobile above tab bar, bottom-right on desktop. |
| Misc | `Badge`, `Avatar`, `Card`, `Separator`, `Tooltip`, `DropdownMenu`, `ToggleGroup`, `ScrollArea`, `Collapsible`, `Calendar` + `Popover` (date range) | |
| Charts | `Chart` (shadcn wrapper over Recharts) | Colours via `--chart-n`; tooltips use `MoneyAmount`. |

### 7.2 Custom components

**`MoneyAmount`**
- Props: `minor: bigint|number`, `currency`, `kind: "expense"|"income"|"transfer"|"balance"|"neutral"`,
  `pending?`, `size: "sm"|"md"|"lg"|"hero"`, `showSign?` (default by kind), `compact?`, `dimCents?` (hero only).
- Renders `<span class="tabular-nums whitespace-nowrap">` with colour per §3.1, visually hidden meaning prefix,
  pending → muted + clock icon (`aria-hidden`) + sr-only "pendente". Never wraps; parent must truncate the label,
  not the amount.

**`CategoryIcon` / `CategoryChip`**
- Icon: disc (28/36/48px) with `color-mix(in oklch, var(--chart-n) 16%, var(--surface))` background and the
  lucide icon in `--chart-n`. Uncategorised: dashed `--input` border, `CircleHelp` icon, label "Sem categoria".
- Chip: icon 20px + label, 32px tall (44px when it's a tap target in pickers), radius 6, states default / hover
  `surface-2` / selected (`primary-soft` bg, primary 1.5px border, check icon) / disabled.
- Category colour is the slot assigned to its group (stable), not by rank; label always visible next to colour.

**`AccountBadge`**
- Compact: logo/monogram 20px + account short name (14px). Full: 40px logo + name + type label. Monogram = first
  letters on `surface-3`. Owner initials optional. Truncates name with tooltip.

**`SyncStatus`** (Phase 2; Phase 1 shows "Manual" / "Importado")
- States: `ok` (positive dot, "Sincronizado há 2 h"), `syncing` (spinner, "A sincronizar…", `aria-live=polite`),
  `stale` (> 36 h, warning, "Sem dados há 2 dias"), `consent_expiring` (warning, "Acesso expira em 5 dias"),
  `error` / `consent_expired` (negative, message + action "Renovar acesso" / "Ver erro"). Always icon + text; dot
  alone only inside AccountBadge, with a tooltip and sr-only text.

**`BudgetProgressBar`** (Phase 3, but define now)
- 8px track `surface-3`, radius full. Fill: `primary` when on pace, `warning` when ≥ 85% or ahead of pace by
  > 10 pts, `negative` beyond 100% (the bar caps at 100% and an overflow segment with diagonal hatch shows the
  excess). Optional pace marker: 2px vertical tick in `foreground`. Text beside/below always states the numbers
  and status word ("Acima 86,50 €"). `role="meter"` with `aria-valuenow/min/max` and `aria-valuetext`
  ("312,40 € de 400,00 €, 78%").

**Others**: `TabBar` (mobile nav), `ReviewBadge` (count pill, `aria-label` with full sentence), `DayGroupHeader`,
`TransactionRow`, `FilterChip` + `FilterBar`, `PeriodStepper` (‹ month ›, keyboard and swipe-free), `EmptyState`
(icon optional, title, text, action), `ErrorState`, `ImportStepper`, `ColumnMapper`, `BrandLogo` (config-driven,
light/dark), `ConfidenceLabel` ("IA · 62%"), `ThemePreview` (branding settings).

---

## 8. Accessibility (WCAG 2.2 AA)

- **Contrast**: text ≥ 4.5:1 (≥ 3:1 for ≥ 24px or ≥ 18.66px bold), UI component boundaries and focus ring ≥ 3:1,
  chart series ≥ 3:1 vs `surface`. Pairs to test in CI for both modes: foreground/muted-foreground on background,
  surface, surface-2; positive/negative/warning/transfer on surface and on their `-soft`; primary-foreground on
  primary (for the derived brand, at config load as well); input and ring on surface.
- **Colour is never alone**: money kinds also carry sign/icon/sr label; statuses use icon + word; budget bars show
  numbers and a status word; charts have direct labels or a legend plus a data table toggle ("Ver como tabela");
  review dot has sr-only text.
- **Focus**: visible 2px `--ring` outline with 2px offset on every interactive element, never removed. Focus not
  obscured (2.4.11): `scroll-padding` for sticky top bar and tab bar (§2.3). Sheets/dialogs trap focus, return it
  to the trigger on close; after a row is removed (review), move focus to the next row.
- **Targets**: ≥ 44×44px for every tap target on touch layouts (exceeds 2.5.8's 24px); 8px gaps. Desktop dense
  controls may be 36px.
- **Keyboard**: everything reachable and operable; logical order; Radix handles menus, combobox arrows, Esc. No
  drag-only interactions (2.5.7): reordering via buttons, sheets close with button and Esc, not only swipe.
- **Semantics**: one `<h1>` per page; landmarks (`header`, `nav` ×2 with distinct labels, `main`); lists are
  `<ul>`; transactions table is a real `<table>` on desktop; day groups are `<section aria-labelledby>`; tab bar
  uses `aria-current="page"`; icon-only buttons have `aria-label` in the UI language; decorative icons
  `aria-hidden`.
- **Forms**: visible labels, `autocomplete` attributes, errors announced (`aria-invalid`, `aria-describedby`,
  summary `role=alert` on submit with links to fields), no placeholder-only labels, paste allowed everywhere,
  accessible authentication (3.3.8): no memory or transcription puzzles; OTP supports paste and autofill.
- **Live updates**: toasts in a polite live region; sync and import progress `aria-live=polite`; badge counts
  updated silently but reflected in nav labels.
- **Motion**: `prefers-reduced-motion` honoured (§2.3); nothing auto-plays or loops.
- **Language**: `<html lang>` follows the UI language (`pt-PT` / `en`); money read correctly because `Intl`
  output plus meaning prefix.
- **Zoom and reflow**: works at 320px CSS width and 200% zoom without horizontal page scroll (tables may scroll
  inside their own region with a visible scroll affordance and sticky first column). Never disable pinch zoom.
- **Safe areas**: `viewport-fit=cover`; tab bar, sheets and sticky footers pad with `env(safe-area-inset-*)`.
- **Dark mode**: tested independently, not inverted; QR code always on white tile.

---

## 9. Implementation checklist for the builder

1. Tokens (§2.3) in `globals.css`; brand derivation function in `packages/core` with unit tests (clamp, foreground
   pick, contrast ≥ thresholds for 10 sample brand colours incl. yellow, navy, red, near-white, near-black).
2. `formatMoney` with tests for pt-PT grouping (`1 234,56 €`), signs, compact, zero, negative balance.
3. `MoneyAmount`, `CategoryIcon/Chip`, `AccountBadge`, `TabBar`, `EmptyState`, `ErrorState` before any screen.
4. Screens in order: auth (5.1–5.2), setup/invite (5.3–5.4), shell (5.5), settings (5.7), accounts (5.8),
   transactions (5.9–5.10), import (5.11), review (5.12), Home Phase 1 (5.6).
5. Capture each screen at 390×844 and 1440×900 in light and dark, with loading, empty and error states, for the
   ux-designer audit.
