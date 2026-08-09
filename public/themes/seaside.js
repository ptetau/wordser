// Seaside: a weathered boardwalk at golden hour. Sun-bleached driftwood
// tiles over a sea-glass tidepool board; buoy-red and coral premiums,
// sandy warm chrome around the edges.
export default {
  id: 'seaside',
  label: 'Seaside',
  description: 'Driftwood tiles on a tidepool board, golden-hour light.',
  canvas: {
    // Sea-glass teal water; the seam rows a shade paler, like shallows.
    cellFill: '#3f7d78',
    seamFill: '#478a84',
    startFill: '#2c605c', // deep lagoon pool under the starting star
    premium: {
      TW: '#a63a28', // buoy red — the loudest marker on the water
      DW: '#d4795a', // coral — warm kin to TW, clearly lighter
      TL: '#22607f', // deep-channel blue
      DL: '#5b96ac', // pale sea-glass blue, bluer + lighter than the teal water
    },
    premiumLabel: 'rgba(255,247,231,0.88)',
    speckle: 'rgba(242,250,244,0.4)', // sun-glitter / sea-foam flecks
    cellStroke: 'rgba(16,52,50,0.28)', // wet hairline between pools
    tile: {
      style: 'bevel',
      // Sun-bleached driftwood: warm bone-grey face, top-lit.
      face: '#e6dac2',
      faceLight: '#f1e8d6',
      faceDark: '#d2c2a5',
      blankFace: '#d4e2d8',
      pendingFace: '#f0c46a',
      pendingFaceLight: '#f8d78c',
      pendingFaceDark: '#e0ab4f',
      edgeDark: '#7c6749', // shadowed plank edge = tile thickness
      edgeLight: 'rgba(255,252,240,0.6)',
      grain: 'rgba(112,90,62,0.20)', // faint weathered wood streaks
      text: '#3a2e20', // dark walnut; >7:1 on the darkest face stop
    },
    letterFont: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    star: 'rgba(244,196,86,0.95)', // low-sun gold on the lagoon
    fruitRing: 'rgba(255,238,204,0.5)', // warm foam halo
    lastMove: 'rgba(255,241,212,0.8)', // fresh foam line around new tiles
    cursor: '#f4c456', // golden-hour glint
    selected: '#93ecdc', // bright sea-foam aqua
    redefine: '#ff6b45', // wet coral flare
  },
  css: {
    '--bg': '#251d15', // dusk-dark boardwalk timber
    '--board': '#1f4a47', // deep tidewater around the play area
    '--panel': '#2f271d', // warm sanded plank panels
    '--panel-border': '#4d3f2c',
    '--ink': '#f2e8d5', // sun-bleached parchment
    '--muted': '#ab9c83',
    '--accent': '#e8834f', // coral / life-ring orange
    '--input-bg': '#382e21',
    '--input-border': '#5a4a31',
    '--tile-face': '#e6dac2',
    '--tile-blank': '#d4e2d8',
    '--tile-text': '#3a2e20',
    '--good': '#93cf9e', // dune-grass green
  },
};
