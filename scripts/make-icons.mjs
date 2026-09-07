/**
 * Generate the home-screen icons.
 *
 * Written down rather than drawn by hand because the first set had faults that are
 * invisible unless you know to look: white wedges baked into the corners of the
 * maskable icon, and a monogram sized past the safe zone.
 *
 * The rule that matters: a maskable icon is FULL BLEED. Android applies its own
 * mask — circle, squircle, rounded square, depending on the launcher — so an icon
 * that draws its own rounded container gets masked twice, which is why the installed
 * app showed a ring inside a ring with the keyline shaved at the clip edge.
 *
 * Everything here is full bleed for the same reason, not only the maskable one.
 * iOS rounds an apple-touch-icon itself, desktop PWA containers round too, and a
 * favicon at 16px has no pixels to spare on padding. There is no context left where
 * baking in our own corners helps.
 *
 * Run: node scripts/make-icons.mjs
 */
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const NAVY = "#16222E";

/**
 * The monogram, matching the header mark in index.html.
 *
 * Its bounding box in that 120-unit space, strokes included, is x 12..101 and
 * y 15.5..106.5 — centre (56.5, 61), so it is placed by that centre rather than by
 * the viewBox, which is not the same point.
 */
const glyph = (scale) => `<g transform="translate(256,256) scale(${scale}) translate(-56.5,-61)"
     fill="none" stroke="#fff" stroke-linecap="butt" stroke-linejoin="miter">
  <path d="M18 24 H70 C91 24 95 32 95 44 C95 56 91 63 70 63 H56" stroke-width="12"/>
  <path d="M56 24 V80 C56 92 47 98 38 98 C28 98 23 91 22 83" stroke-width="17"/>
</g>`;

/**
 * A maskable icon's content must sit inside a centred circle 80% of the canvas —
 * radius 204.8 on 512. At this scale the monogram spans 263 x 268, putting its
 * corners 188 from centre, so it survives whichever shape the launcher picks.
 */
const MASKABLE_SCALE = 2.95;

/** No mask anywhere else, so the safe zone does not apply and bigger reads better. */
const PLAIN_SCALE = 3.35;

const icon = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">` +
  `<rect width="512" height="512" fill="${NAVY}"/>${glyph(scale)}</svg>`;

const TARGETS = [
  { file: "icon-192.png", size: 192, scale: PLAIN_SCALE },
  { file: "icon-512.png", size: 512, scale: PLAIN_SCALE },
  { file: "icon-512-maskable.png", size: 512, scale: MASKABLE_SCALE },
];

for (const t of TARGETS) {
  await sharp(Buffer.from(icon(t.scale)))
    .resize(t.size, t.size)
    // Flattened onto the background: a stray alpha channel is how the old set ended
    // up with white corners, and iOS composites transparency unpredictably anyway.
    .flatten({ background: NAVY })
    .png()
    .toFile(join(PUBLIC, t.file));
  console.log(`wrote ${t.file} (${t.size}px, glyph x${t.scale})`);
}
