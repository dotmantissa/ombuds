# Ombuds visual system

Design variance rolls, seed `1790853033640`.

| Axis | Roll | Why it fits Ombuds |
|---|---|---|
| Layout archetype | Hero dominant with a supporting rail | Ombuds produces documents. A brief with a citation margin is the native shape of the product, so the rail is not decoration, it is where the sources live. |
| Type pairing | Condensed grotesk + mono | Archivo at a narrow width axis for headlines reads like a public notice. IBM Plex Mono carries every code, clause id, docket number and dollar figure, because those are the things a reader checks character by character. |
| Motion signature | One orchestrated load sequence | The rail rules draw, the headline sets, the evidence rows stamp in once. After that the page is still. No ambient drift, no fade up on every scroll. |
| Structural device | Evidence margin rail | Each claim in a verdict is tied by a hairline into the margin where its source sits. This is the whole trust argument made visible. |
| Accent shape | Full bleed rules | Flat panels divided by hairlines that run edge to edge, like a ledger page. No soft shadow card kit. |

## Colour

Base palette is `#a238ff`, `#ffffff`, `#1b191f`. Everything else is derived.

### Dark (default)

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#1b191f` | page ground |
| `--surface` | `#221f27` | panel |
| `--raised` | `#2a2630` | nested panel, input |
| `--line` | `#3a3542` | hairline rule |
| `--line-strong` | `#4b4455` | active rule, focus ring base |
| `--text` | `#f4f2f7` | primary copy |
| `--text-2` | `#a39daf` | secondary copy |
| `--text-3` | `#726b7e` | captions, meta |
| `--signal` | `#a238ff` | brand, primary action |
| `--signal-bright` | `#c285ff` | brand on dark where text contrast is needed |
| `--signal-wash` | `rgba(162,56,255,0.12)` | selected row, active chip |
| `--win` | `#3ddc97` | overturn recommended |
| `--loss` | `#ff5d5d` | denial upheld |
| `--wait` | `#ffb224` | adjudicating, pending |

### Light

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#faf9fb` | page ground |
| `--surface` | `#ffffff` | panel |
| `--raised` | `#f4f2f7` | nested panel, input |
| `--line` | `#e4e1e9` | hairline rule |
| `--line-strong` | `#cdc8d6` | active rule |
| `--text` | `#1b191f` | primary copy |
| `--text-2` | `#5d5668` | secondary copy |
| `--text-3` | `#8b8397` | captions, meta |
| `--signal` | `#8a1ee6` | brand darkened to hold contrast on white |
| `--win` | `#0f9d63` | overturn recommended |
| `--loss` | `#d93636` | denial upheld |
| `--wait` | `#b26a00` | adjudicating, pending |

## Type roles

- `--font-display`: Archivo variable, width axis 75 to 88, weight 600 to 700. Headlines and section heads.
- `--font-body`: Archivo variable, width 100, weight 400 to 500. Running copy.
- `--font-mono`: IBM Plex Mono. Codes, clause ids, docket numbers, money, timestamps, addresses, every label in the margin rail.

Scale is a 1.25 ratio off 16px, clamped for viewport: 12, 13, 14, 16, 20, 25, 31, 39, 49, 61.

## Geometry

- Corner radius: `2px` everywhere. One exception, the pill chip at `999px`, used only for case status.
- No box shadows anywhere. Depth comes from hairlines and ground shifts.
- Rules run full bleed on section boundaries, inset only inside panels.
- Rail width: `clamp(0px, 18vw, 260px)`, collapses under 1100px and the citations move inline under their claim.

## Banned here

ALL CAPS tracked eyebrow labels, em dash label fragments, arrows glued to every link, decorative 01 / 02 / 03 markers, matching radius plus soft grey shadow on every card, fade and slide up on every section, lift on hover on every card. Status chips and docket numbers do the labelling work instead, and both carry real data.
