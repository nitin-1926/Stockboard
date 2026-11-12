# Stockboard design system

Design read: personal investing terminal for an owner and a finance manager. Dense data, calm chrome, sharp type. Reference points: Kite's restraint, Mercury's neutral surfaces, Linear's density. Not a landing page.

Dials: variance 3, motion 3, density 7.

## Principles

1. Numbers are the interface. Everything else steps back: chrome is neutral graphite, the only color on screen is data (gain/loss) and one saffron accent.
2. One idea per section. No explainer paragraphs under headings. If a label needs a sentence, the label is wrong.
3. Hairlines over boxes. Sections separate with space and 1px borders. A bordered surface (`Panel`) only where content is a self-contained unit (KPI group, chart, table).
4. Show the answer, hide the plumbing. Source badges, approximation markers, ledger provenance, supersession flags live on detail pages, never in primary tables.

## Tokens (src/app/globals.css)

Neutrals are warm graphite (oklch hue 85, chroma <= 0.006). Never blue-tinted.

| token | light | dark | use |
|---|---|---|---|
| background | 0.982 | 0.145 | page |
| card | 0.997 | 0.175 | Panel surface |
| muted | 0.955 | 0.205 | hover row, segmented track |
| foreground | 0.18 | 0.955 | primary text |
| muted-foreground | 0.47 | 0.69 | labels, secondary |
| faint | 0.6 | 0.52 | tertiary meta (timestamps) |
| border | fg / 9% | white / 8% | hairlines |
| brand | saffron 0.66 0.16 62 | 0.80 0.15 75 | active nav, focus ring, chart line, live state |
| gain | 0.53 0.15 152 | 0.78 0.17 152 | up |
| loss | 0.56 0.21 27 | 0.70 0.19 25 | down |

Colorblind palette (`data-palette="cb"`): gain blue, loss orange.

Radius: one scale. `--radius: 0.375rem` (6px). Panels 8px (`rounded-lg`), controls 6px (`rounded-md`), tags 4px (`rounded-sm`). No pills except the live indicator.

Shadows: none on panels. Popovers/menus: `shadow-lg` tinted, 1px border.

## Type

IBM Plex Sans (UI, tickers, figures with `tabular-nums`) and IBM Plex Mono (codes, ids only).

| role | class |
|---|---|
| hero figure | `text-[2.75rem] leading-none font-semibold tracking-[-0.03em]` (sm: 3.25rem) |
| page title | `text-xl font-semibold tracking-[-0.015em]` |
| section title | `text-sm font-semibold` |
| KPI figure | `text-xl font-semibold tracking-[-0.02em]` |
| body / table | `text-[13px]` (`text-sm` on mobile forms) |
| label | `text-xs text-muted-foreground` |
| ticker | `text-[13px] font-semibold tracking-[0.01em]` (Plex Sans) |

No uppercase-tracked eyebrows. No em dashes in UI copy. Missing values render `-` in faint.

## Components

- `PageHeader` (src/components/page-header.tsx): title + optional meta (one line, faint) + right-aligned actions. Nothing else.
- `Panel` (src/components/panel.tsx): `rounded-lg border bg-card`. `PanelHeader` = section title left, small control/meta right, `px-4 py-3 border-b`.
- `Stat`: label above figure. Figures right-aligned in tables, left-aligned in KPI rows.
- `Delta`: explicit +/- sign + magnitude in gain/loss color (the sign, not color, carries direction).
- `Ticker`: mono symbol + muted name below (name hidden when equal to symbol).
- `Tag`: 4px radius, 11px text, neutral border. Variants: neutral, buy (gain tint), sell (loss tint), brand.
- `Segmented`: URL-state tabs, 32px high, muted track, active = card surface + foreground.
- Tables: header row `text-xs text-muted-foreground font-medium`, `h-9`, sticky; body rows `h-12`, hairline between rows (`divide-y`), hover `bg-muted/60`. Numbers right-aligned. First column sticky on mobile horizontal scroll.
- Charts (Recharts): single series uses `--brand` line with 10% area fill fading to 0. Grid lines: horizontal only, `border` token. Axis text 11px faint. Tooltip = Panel style.
- Live indicator: small pill `NSE open` with a 6px brand dot that pulses (respects reduced motion). The only decorative dot in the app, and it carries real state.

## Shell

Top bar (56px, sticky, background with hairline bottom border): wordmark left, primary nav tabs (Overview, Holdings, Trades, Watchlist, Buckets, Targets), right cluster: market status, theme toggle, settings (owner), account menu. Active tab: foreground text + 2px brand underline.

Mobile (< lg): top bar keeps wordmark + actions; primary nav moves to a bottom tab bar (Overview, Holdings, Trades, Watchlist, More). Content `pb-24` to clear it.

Content: `max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8`. Vertical rhythm between sections: `gap-8`.

## Information architecture

Primary: Overview, Holdings, Trades, Watchlist, Buckets, Targets. Symbol detail at `/symbol/[id]`.
Settings (owner only, `/settings/*` with tab bar): Brokers, Sharing, Import, Ledger, Preferences.
Removed as standalone pages: History (value chart + calendar move to Overview), Allocation (sector/holding mix moves to Overview).
