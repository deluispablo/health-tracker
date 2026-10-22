# Tracker glyphs

One source for the log symbols used by the watch face, the watch Tile and the dashboard. Colours are in `tokens.json`.

| Folder | What | Format |
|---|---|---|
| `icons/` | Button icons (face menu, Tile, dashboard quick log), drawn in the tracker's `ink` on a solid circle of its `fill` | 24 × 24 viewBox, stroke 2.5, round caps and joins, `currentColor` |
| `marks/` | Marks on the dial's log ring, drawn in the tracker's `fill` | 16 × 16 viewBox centred on 0,0; the ring's outward direction is −y |
| `moods/` | The eight mood faces, drawn in `moods.ink` on a circle of the mood's fill | 24 × 24 viewBox, `currentColor` |

- Melatonin, protein and creatine share one colour and one dial mark (`marks/suplemento.svg`); their icons tell them apart.
- On the dial every mark gets a halo in the background colour (2.2 px around fills, 6.6 px under the cigarette line), as the watch already draws them.
- The water button shows goal progress as a ring around its disc; the text form is "750 / 2000 ml" (dashboard daily totals).
