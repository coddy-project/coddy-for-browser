// The interface scale of the settings page: how much larger or smaller the
// extension draws its pages and the web UI in the panel, in percent, on top of
// the size the browser gives them. The stylesheet takes it as --scale.

export const SCALES = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
export const DEFAULT_SCALE = 100;

// checkScale refuses anything but a scale of the list.
export function checkScale(scale) {
  if (!SCALES.includes(scale)) throw new Error(`Choose a scale from ${SCALES[0]}% to ${SCALES.at(-1)}%`);
  return scale;
}

// scaleOf reads a stored scale: one off the list, or none in the settings of
// an older version, is the default.
export function scaleOf(stored) {
  return SCALES.includes(stored) ? stored : DEFAULT_SCALE;
}

// applyScale gives a page's root element the scale.
export function applyScale(root, scale) {
  root.style.setProperty("--scale", String(scaleOf(scale) / 100));
}
