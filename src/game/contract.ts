/**
 * What NayosBeat demands of a sprite. **These numbers are not ours** — they are the game's, and a
 * drawing that breaks them is refused by its pipeline before anything is generated.
 *
 * They live in one small file on purpose. NBPIX is a separate repository, so nothing enforces that
 * the two stay in step: if the game ever changes a cell's size or moves its anchor, it has to be
 * changed **here too**, and a test (tests/roto.test.ts) states each value out loud so a drift is at
 * least loud rather than silent.
 *
 * | ici | là-bas, dans NayosBeat |
 * |---|---|
 * | `CELL_SIZE`, `ANCHOR` | `src/art/types.ts` |
 * | `CELL_MARGIN`, `LOWEST_ROW` | `tools/sprites/cell.ts` |
 * | `PORTRAIT_SIZE` | `tools/sprites/drawn.ts` |
 */

/** Every frame is a square cell, in sprite pixels; strips are one row of cells, facing right. */
export const CELL_SIZE = 256;

/** Pixel of the cell where the centre of the feet stands, in every frame. */
export const ANCHOR = { x: 128, y: 248 } as const;

/** Empty sprite pixels kept along the left, right and top edges of a cell: 2 world px. */
export const CELL_MARGIN = 4;

/** The lowest row a body may draw on: the soles end on the anchor's row, give or take. */
export const LOWEST_ROW = ANCHOR.y + 2;

/** The bust of the select screen: a square of this side, one frame. */
export const PORTRAIT_SIZE = 96;

/**
 * The standing height of a fighter, measured on a strip drawn by hand
 * (NayosBeat's art-src/feline/idle.png, frame 1: rows 92 to 248 of a 256 px cell).
 */
export const STANDING_HEIGHT = 157;
