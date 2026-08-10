// A Victorian games parlour: mahogany tiles on deep-green baize,
// brass and burgundy premiums, lamplit walnut chrome.
export default {
  id: 'parlour',
  label: 'Parlour',
  description: 'Mahogany tiles on green baize in a lamplit Victorian parlour.',
  canvas: {
    // Deep-green baize felt, with a faint chalk-dust speckle.
    cellFill: '#215940',
    seamFill: '#17472f',
    startFill: '#2f6d4b',
    // Word premiums in burgundy velvet, letter premiums in brass/olive-brass.
    premium: { TW: '#6b1524', DW: '#9c454d', TL: '#8c6714', DL: '#66763f' },
    premiumLabel: 'rgba(245,230,198,0.85)',
    tile: {
      style: 'bevel',
      // Polished mahogany, lit from above.
      face: '#63321e',
      faceLight: '#8a4a2c',
      faceDark: '#38190e',
      // Freshly played tiles glow a warmer lamplit amber.
      pendingFace: '#8f5318',
      pendingFaceLight: '#8f5318',
      pendingFaceDark: '#5f350c',
      blankFace: '#57443a',
      edgeDark: '#26100a',
      edgeLight: 'rgba(255,214,160,0.32)',
      grain: 'rgba(24,9,4,0.32)',
      // Ivory-inlay lettering; >= 7:1 on every face above.
      text: '#f7ead0',
    },
    letterFont: 'Georgia, "Times New Roman", serif',
    speckle: 'rgba(214,236,205,0.14)',
    cellStroke: 'rgba(9,28,19,0.4)',
    star: 'rgba(222,182,92,0.95)',
    fruitRing: 'rgba(243,222,164,0.45)',
    lastMove: 'rgba(255,178,104,0.92)',
    cursor: '#eec86a',
    selected: '#f6ead0',
    redefine: '#cf8de0',
  },
  css: {
    '--bg': '#20140d',
    '--board': '#143423',
    '--panel': '#2b1b10',
    '--panel-border': '#54381f',
    '--ink': '#f0e4cd',
    '--muted': '#b39a76',
    '--accent': '#d9a94f',
    '--input-bg': '#3b2716',
    '--input-border': '#5e4225',
    '--tile-face': '#5c2f1d',
    '--tile-blank': '#57443a',
    '--tile-text': '#f7ead0',
    '--good': '#b5cf8e',
  },
};
