// Theme registry. Each entry lazy-imports a module whose default export
// follows the schema in midnight.js (the reference implementation):
//
//   canvas: colors and style flags for the board renderer. tile.style may be
//     'flat' or 'bevel'; bevel honours faceLight/faceDark/edgeDark/edgeLight.
//     Optional extras: tile.grain (a stroke colour for wood streaks),
//     speckle (a dot colour for felt-like board texture), cellStroke.
//   css: CSS custom properties applied to the page chrome.
//
// Add a theme by dropping a module here and listing it below.
export const THEMES = {
  midnight: () => import('./midnight.js'),
  parlour: () => import('./parlour.js'),
  scriptorium: () => import('./scriptorium.js'),
  seaside: () => import('./seaside.js'),
};
export const DEFAULT_THEME = 'parlour';
