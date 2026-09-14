// Auto-theming: derive a cohesive color theme from the page URL's embedding and
// apply it to the sidebar automatically whenever a page loads. The embedding is
// a 384-d normalized vector; we project it onto a few fixed directions to get
// stable hue/saturation/energy features, then snap the hue to one of 50 curated
// aesthetic colors and build a readable dark palette (background, surface,
// accent, text).

// Projection directions (fixed, hand-tuned).
const THEME_DIRS = [
  [0.21, -0.13, 0.47, 0.09, -0.31, 0.52, -0.08, 0.19], // hue
  [-0.34, 0.28, 0.11, -0.46, 0.07, 0.22, 0.41, -0.15], // saturation
  [0.12, 0.39, -0.27, 0.18, 0.44, -0.09, -0.33, 0.26], // energy
];

// 50 hand-picked aesthetic hues (degrees) spanning the wheel, ordered so
// adjacent entries feel like a smooth, pleasing gradient.
const THEME_HUES = [
  4, 12, 20, 28, 36, 44, 52, 60, 72, 84, 96, 108, 120, 132, 144, 156, 168, 180,
  192, 204, 216, 228, 240, 252, 264, 276, 288, 300, 312, 324, 336, 348,
  8, 16, 40, 64, 88, 112, 136, 160, 184, 208, 232, 256, 280, 304, 328, 352, 24, 200,
];

function project(embedding, dir) {
  let sum = 0;
  for (let i = 0; i < dir.length; i++) sum += embedding[i] * dir[i];
  return sum;
}

// Squash to 0..1 with a soft logistic so small vectors don't blow out.
function squash(x) {
  return 1 / (1 + Math.exp(-x * 6));
}

// Pick the curated hue whose position on the wheel is closest to the raw hue.
function snapHue(hue) {
  let best = THEME_HUES[0];
  let bestD = 360;
  for (const h of THEME_HUES) {
    const d = Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue));
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

export function embeddingToTheme(embedding) {
  const rawHue = (squash(project(embedding, THEME_DIRS[0])) * 360 + 360) % 360;
  const hue = snapHue(rawHue);
  const sat = 0.45 + squash(project(embedding, THEME_DIRS[1])) * 0.4; // 0.45..0.85
  const energy = squash(project(embedding, THEME_DIRS[2])); // 0..1

  const bgLight = 0.1 + (1 - energy) * 0.06; // darker when calmer
  const bg = `hsl(${hue}, ${Math.round(sat * 55)}%, ${bgLight * 100}%)`;
  const surface = `hsl(${hue}, ${Math.round(sat * 45)}%, ${(bgLight + 0.05) * 100}%)`;
  const accent = `hsl(${hue}, ${Math.round(sat * 100)}%, ${52 + energy * 8}%)`;
  const text = `hsl(${hue}, ${Math.round(sat * 28)}%, 92%)`;

  return { bg, surface, accent, text };
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (!theme) {
    root.style.removeProperty('--theme-bg');
    root.style.removeProperty('--theme-surface');
    root.style.removeProperty('--theme-accent');
    root.style.removeProperty('--theme-text');
    return;
  }
  root.style.setProperty('--theme-bg', theme.bg);
  root.style.setProperty('--theme-surface', theme.surface);
  root.style.setProperty('--theme-accent', theme.accent);
  root.style.setProperty('--theme-text', theme.text);
}
