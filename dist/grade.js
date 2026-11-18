"use strict";

// Preview and export share the same interpolated color grid.

const COLOR_GRID_STEPS = 16;
const COLOR_GRID_SIDE = COLOR_GRID_STEPS + 1;
const GREEN_STRIDE = 3 * COLOR_GRID_SIDE;
const BLUE_STRIDE = GREEN_STRIDE * COLOR_GRID_SIDE;

function buildColorGrid(getDelta) {
  const grid = new Float32Array(BLUE_STRIDE * COLOR_GRID_SIDE);
  let i = 0;
  for (let b = 0; b <= COLOR_GRID_STEPS; b++) {
    for (let g = 0; g <= COLOR_GRID_STEPS; g++) {
      for (let r = 0; r <= COLOR_GRID_STEPS; r++) {
        const rgb = [r, g, b].map(value => value / COLOR_GRID_STEPS);
        for (const delta of getDelta(rgb)) grid[i++] = delta;
      }
    }
  }
  return grid;
}

function mix(a, b, weight) {
  return a + weight * (b - a);
}

function interpolateDelta(grid, i, r, g, b) {
  const green = i + GREEN_STRIDE;
  const blue = i + BLUE_STRIDE;
  const cyan = blue + GREEN_STRIDE;
  const low = mix(mix(grid[i], grid[i + 3], r), mix(grid[green], grid[green + 3], r), g);
  const high = mix(mix(grid[blue], grid[blue + 3], r), mix(grid[cyan], grid[cyan + 3], r), g);
  return mix(low, high, b);
}

function applyColorGrid(pixels, strength, grid) {
  if (strength === 0) return;
  const scale = COLOR_GRID_STEPS / 255;
  const maxCell = COLOR_GRID_STEPS - 1;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;

    const r = pixels[i] * scale;
    const g = pixels[i + 1] * scale;
    const b = pixels[i + 2] * scale;
    const ri = Math.min(Math.floor(r), maxCell);
    const gi = Math.min(Math.floor(g), maxCell);
    const bi = Math.min(Math.floor(b), maxCell);
    const index = bi * BLUE_STRIDE + gi * GREEN_STRIDE + ri * 3;

    pixels[i] += strength * interpolateDelta(grid, index, r - ri, g - gi, b - bi);
    pixels[i + 1] += strength * interpolateDelta(grid, index + 1, r - ri, g - gi, b - bi);
    pixels[i + 2] += strength * interpolateDelta(grid, index + 2, r - ri, g - gi, b - bi);
  }
}

function createPreset(suffix, getDelta) {
  const grid = buildColorGrid(getDelta);
  return { grade: (pixels, strength) => applyColorGrid(pixels, strength, grid), suffix };
}

const TONE_LEVELS = [0, 16, 32, 64, 96, 128, 160, 192, 224, 240, 255];

function monochromeFilmDelta(rgb, tone, chroma) {
  const [red, green, blue] = rgb;
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return filmColorDelta(rgb, tone, chroma).map((delta, i) => delta + 255 * (luma - rgb[i]));
}

function filmColorDelta([red, green, blue], tone, chroma) {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const code = luma * 255;
  let index = 0;
  while (index < TONE_LEVELS.length - 2 && code > TONE_LEVELS[index + 1]) index++;
  const lower = TONE_LEVELS[index];
  const fraction = (code - lower) / (TONE_LEVELS[index + 1] - lower);

  // Taper the fitted chroma correction for very saturated inputs that the samples rarely cover.
  const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
  const t = Math.max(0, (spread - 0.45) / 0.55);
  const chromaWeight = 1 - 0.65 * t * t * (3 - 2 * t);
  const redGreen = (red - green) * chromaWeight;
  const blueGreen = (blue - green) * chromaWeight;
  const centeredLuma = 2 * luma - 1;
  const midtoneWeight = 4 * luma * (1 - luma);
  const features = [
    redGreen, blueGreen, redGreen * centeredLuma, blueGreen * centeredLuma,
    redGreen ** 2, redGreen * blueGreen, blueGreen ** 2,
    redGreen * midtoneWeight, blueGreen * midtoneWeight,
    redGreen ** 2 * centeredLuma, redGreen * blueGreen * centeredLuma, blueGreen ** 2 * centeredLuma,
  ];

  return tone[index].map((value, channel) => {
    const offset = mix(value, tone[index + 1][channel], fraction);
    return chroma.reduce((sum, coefficient, i) => sum + features[i] * coefficient[channel], offset);
  });
}

// GR III color offsets in sRGB, fitted to paired Standard and Film renders
// of real DNGs with Camera Matching profiles, then checked against in-camera
// JPEG comparisons by mookio, hisway and Everyday GR. The fit is blended with
// the earlier camera JPEG calibration to limit extrapolation.
const ricohPositiveTone = [
  [0, 0, 0],
  [-5.95, -5.76, -6.36],
  [-11.73, -11.56, -13.13],
  [-18.03, -19.27, -19.06],
  [-19.59, -19.65, -17.39],
  [-13.78, -12.23, -10.99],
  [-6.20, -5.72, -6.09],
  [-2.81, -2.49, -3.68],
  [-0.63, -1.67, -2.31],
  [-1.71, -1.17, 1.51],
  [0, 0, 0],
];
const ricohPositiveChroma = [
  [-3.66, 3.10, 4.66],
  [-19.00, -6.60, -47.76],
  [34.10, -15.09, -11.96],
  [-21.70, -1.36, 28.18],
  [-0.24, -0.01, 5.89],
  [13.95, 3.06, -11.61],
  [-22.04, -5.54, 42.92],
  [32.15, -7.96, -15.58],
  [-36.12, -5.25, 16.95],
  [-4.46, -2.47, -3.83],
  [3.88, -0.06, 6.77],
  [-5.89, -0.89, -13.32],
];
const ricohNegativeTone = [
  [0.0, 0.0, 0.0],
  [2.64, 1.6, 1.81],
  [5.01, 3.07, 3.43],
  [7.83, 9.16, 8.78],
  [11.81, 13.02, 12.93],
  [14.2, 15.43, 15.57],
  [14.95, 15.73, 15.51],
  [14.07, 13.81, 12.89],
  [9.94, 7.73, 6.09],
  [5.14, 3.3, 6.52],
  [0.0, 0.0, 0.0],
];
const ricohNegativeChroma = [
  [20.09, 29.11, 9.28],
  [37.92, 30.3, -40.38],
  [-24.43, -1.0, 20.36],
  [0.72, -8.93, -33.7],
  [1.55, 27.32, 7.18],
  [-24.75, -17.15, -8.75],
  [42.33, 42.81, 19.46],
  [6.08, 15.34, 0.19],
  [15.47, 19.88, -12.6],
  [0.04, -4.34, 0.1],
  [3.52, 3.05, 1.17],
  [-10.16, -13.93, -0.85],
];

// Fujifilm tone and chroma offsets fitted to aligned comparisons by Take Kayo,
// John Peltier and X. H. Provia is the input for the classic simulations.
// Standard uses the softer Pro Neg. Std as the input and Provia as the target.
const classicChromeTone = [
  [0, 0, 0],
  [-6.11, -6.03, -6.41],
  [-7.61, -6.74, -6.38],
  [-5.41, -5.56, -4.70],
  [-1.66, -1.49, -1.62],
  [0.53, 1.02, 1.25],
  [5.12, 4.65, 4.43],
  [4.45, 3.96, 3.33],
  [2.75, 1.69, 1.59],
  [1.03, 0.87, 1.72],
  [0, 0, 0],
];
const classicChromeChroma = [
  [-19.99, 12.30, 9.33],
  [-13.87, 11.73, -65.26],
  [-0.75, -0.75, -0.53],
  [6.44, -1.00, -5.44],
  [0.64, 22.83, 15.22],
  [34.55, -1.49, -7.73],
  [-12.82, -0.01, -14.97],
];

const classicNegativeTone = [
  [0.0, 0.0, 0.0],
  [-1.1, 1.05, -1.31],
  [-4.65, -0.45, -1.92],
  [-12.51, -8.22, -7.71],
  [-8.71, -5.82, -5.18],
  [9.64, 5.94, 5.03],
  [29.59, 19.1, 12.92],
  [31.91, 21.03, 16.14],
  [20.8, 10.74, 6.36],
  [11.43, 4.87, 3.55],
  [0.0, 0.0, 0.0],
];
const classicNegativeChroma = [
  [-34.66, 2.68, -40.77],
  [24.3, 29.27, -73.83],
  [-13.08, -26.04, -15.32],
  [0.86, -7.67, -2.98],
  [22.28, 4.97, -2.82],
  [-58.02, -25.2, -26.13],
  [-0.73, 8.71, 25.59],
];

const proviaTone = [
  [0.0, 0.0, 0.0],
  [-2.11, -2.99, -2.88],
  [-3.24, -3.94, -3.9],
  [-2.65, -3.02, -3.44],
  [-0.73, -0.55, -1.66],
  [0.46, -0.14, -0.04],
  [0.69, -0.5, -0.36],
  [-0.07, -0.72, -0.33],
  [-0.44, -0.82, -1.33],
  [-1.0, -1.53, -0.66],
  [0.0, 0.0, 0.0],
];
const proviaChroma = [
  [54.6, 3.07, -18.23],
  [-3.28, 1.79, 45.67],
  [-29.19, 9.43, 14.01],
  [-6.75, 10.8, -18.07],
  [-38.89, -16.25, -7.47],
  [-26.45, 3.48, -11.45],
  [-15.95, 0.61, -16.3],
];

// Color Chrome OFF / STRONG comparisons from Fujifilm and Hirophotalk.
const colorChromeCoefficients = [
  [-64.48, -55.51, -69.30],
  [77.60, 72.66, 64.19],
  [-4.14, -16.64, 12.86],
  [22.45, 18.96, 19.55],
];

function colorEffectDelta([red, green, blue]) {
  const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
  // A one-cell neutral margin prevents interpolation from tinting gray pixels.
  const neutralWeight = Math.min(1, Math.max(0, (spread - 1 / COLOR_GRID_STEPS) * 12));
  const colorWeight = Math.max(0, Math.max(red, green) - blue) * neutralWeight;
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const [base, lightness, saturation, redGreen] = colorChromeCoefficients;

  return base.map((value, i) => colorWeight * (
    value + lightness[i] * luma + saturation[i] * spread + redGreen[i] * (red - green)
  ));
}

// F Series looks fitted from paired sRGB photos, using Provia as the baseline.
// Hirophotalk and X. H. published the same scenes across these simulations.
// These offsets describe the still-photo look with optional grain applied separately.
const velvia = {
  tone: [
    [0, 0, 0],
    [-6.92, -6.03, -6.44],
    [-12.18, -11.67, -10.38],
    [-3.66, -3.70, -2.79],
    [1.82, 2.26, 1.36],
    [0.46, 0.33, -0.34],
    [-2.79, -1.97, -3.94],
    [-5.49, -6.02, -5.05],
    [3.02, 2.09, 2.19],
    [4.19, 4.65, 2.29],
    [0, 0, 0],
  ],
  chroma: [
    [64.89, 5.38, -25.46],
    [3.85, -34.01, 38.39],
    [-28.24, -10.90, -11.05],
    [-27.20, 18.57, -12.88],
    [-21.98, 13.67, -9.22],
    [-24.36, -7.43, 40.58],
    [-2.74, -11.06, 16.41],
    [-40.77, -10.81, 7.67],
    [0.99, 15.20, 14.98],
    [3.70, -14.73, -17.57],
    [7.01, -9.93, -7.49],
    [21.67, -0.06, -39.81],
  ],
};

const astia = {
  tone: [
    [0.0, 0.0, 0.0],
    [-1.59, -1.75, -2.4],
    [-3.59, -3.71, -3.57],
    [-1.74, -1.79, -1.32],
    [2.28, 1.9, 1.22],
    [1.91, 2.67, 2.32],
    [1.62, 2.16, 0.78],
    [-1.25, -1.72, -1.44],
    [-3.42, -4.18, -3.65],
    [-3.83, -3.51, -0.23],
    [0.0, 0.0, 0.0],
  ],
  chroma: [
    [17.91, 18.2, -0.18],
    [-15.86, -9.79, -8.47],
    [-15.71, 3.63, 28.63],
    [17.82, 5.71, -46.54],
    [-8.2, -10.24, 22.72],
    [54.16, 6.46, -35.37],
    [-26.75, -10.36, 20.72],
    [-21.55, -17.9, -17.91],
    [-4.21, -2.13, 26.4],
    [3.61, -5.44, -8.28],
    [2.62, -6.38, -9.09],
    [11.22, 0.56, -19.53],
  ],
};

const realaAce = {
  tone: [
    [0.0, 0.0, 0.0],
    [2.4, 2.6, 1.96],
    [5.24, 4.93, 4.59],
    [1.58, 1.39, 1.77],
    [-2.85, -3.32, -2.4],
    [0.38, 0.78, 1.26],
    [10.07, 9.82, 9.78],
    [12.3, 12.11, 10.71],
    [5.51, 4.43, 6.37],
    [1.43, 1.53, 1.28],
    [0.0, 0.0, 0.0],
  ],
  chroma: [
    [-17.13, 1.54, 6.3],
    [-19.47, -30.26, -19.21],
    [-5.46, 19.25, 7.97],
    [12.6, 10.95, -7.21],
    [-27.63, -12.13, -18.19],
    [54.23, 67.87, 26.98],
    [-49.8, -26.92, -55.33],
    [8.01, 16.98, 5.58],
    [1.22, 31.54, 6.11],
    [5.99, 22.62, -0.17],
    [0.84, 10.44, -9.3],
    [10.44, 25.64, -25.7],
  ],
};

const proNegHi = {
  tone: [
    [0, 0, 0],
    [-4.23, -3.79, -4.21],
    [-9.90, -9.30, -8.65],
    [-5.54, -5.86, -5.59],
    [0.14, 0.32, -1.65],
    [-0.87, -0.66, -0.86],
    [-1.59, -1.08, -0.21],
    [-0.86, -1.16, -0.38],
    [1.45, 1.09, 2.01],
    [2.43, 2.76, 2.89],
    [0, 0, 0],
  ],
  chroma: [
    [-18.17, 7.63, 5.80],
    [-3.31, -5.75, -20.96],
    [29.28, -1.13, 1.09],
    [-4.65, 2.81, 0.88],
    [34.35, 14.78, -2.78],
    [-2.45, -4.82, 4.21],
    [11.02, -3.12, -1.48],
    [-18.75, -3.60, 14.98],
    [7.42, 5.38, -1.16],
    [14.30, 2.39, -0.32],
    [6.97, -2.11, 0.25],
    [12.61, -0.73, 0.94],
  ],
};

const proNegStd = {
  tone: [
    [0.0, 0.0, 0.0],
    [2.42, 2.74, 2.88],
    [3.84, 4.19, 4.11],
    [2.69, 2.62, 2.72],
    [0.99, 1.57, 0.97],
    [-0.72, -0.41, -0.21],
    [-0.59, 0.15, 0.04],
    [-0.36, -0.59, -0.37],
    [-0.44, -0.34, -0.18],
    [-1.35, -1.11, -0.46],
    [0.0, 0.0, 0.0],
  ],
  chroma: [
    [-41.93, -3.98, 15.49],
    [3.81, 2.81, -36.79],
    [39.0, -3.25, -2.98],
    [5.36, -4.48, 23.51],
    [29.43, -1.61, -5.94],
    [33.33, -5.51, 5.12],
    [-2.51, -1.5, 23.82],
    [-6.25, 8.32, 1.09],
    [0.56, 1.53, -4.26],
    [12.74, 4.57, -0.49],
    [4.5, -0.9, 7.81],
    [8.12, 0.41, 3.51],
  ],
};

const nostalgicNeg = {
  tone: [
    [0.0, 0.0, 0.0],
    [10.02, 6.65, 5.84],
    [8.69, 6.55, 4.26],
    [5.33, 3.59, 2.74],
    [4.23, 1.68, 0.5],
    [3.22, -0.4, -1.27],
    [8.7, 2.09, -3.55],
    [10.35, 2.61, -5.34],
    [4.82, -0.19, -5.63],
    [1.79, -0.9, -5.02],
    [0.0, 0.0, 0.0],
  ],
  chroma: [
    [-37.91, -22.09, -19.18],
    [14.02, -5.26, 14.73],
    [-19.26, 6.24, 1.01],
    [9.3, 5.08, -41.07],
    [-40.51, -28.05, -71.48],
    [97.89, 46.15, 15.41],
    [-66.4, -23.21, -58.24],
    [18.73, 33.09, -6.91],
    [-24.96, 25.09, -52.11],
    [10.08, 6.17, -0.37],
    [0.09, 2.15, 21.06],
    [9.54, 16.67, -2.56],
  ],
};

const eterna = {
  tone: [
    [0, 0, 0],
    [11.17, 10.90, 11.14],
    [11.96, 11.49, 11.12],
    [4.48, 4.15, 5.03],
    [0.07, 0.39, 0.36],
    [-0.62, -0.62, 0.08],
    [-0.89, -0.61, -1.42],
    [-3.06, -3.27, -3.53],
    [-6.26, -6.28, -6.18],
    [-7.01, -6.62, -5.61],
    [0, 0, 0],
  ],
  chroma: [
    [-45.44, -0.45, 22.64],
    [2.88, -2.37, -73.62],
    [30.14, 3.15, -4.26],
    [17.45, -8.86, 17.80],
    [29.04, 0.35, -26.54],
    [45.60, -0.31, 20.81],
    [-2.69, -1.36, 6.03],
    [-19.68, 9.54, -15.36],
    [2.80, 10.95, -4.30],
    [12.32, 3.65, -9.44],
    [8.20, -1.73, 5.38],
    [11.05, 1.60, -6.68],
  ],
};

const eternaBleachBypass = {
  tone: [
    [0.0, 0.0, 0.0],
    [2.86, 3.04, 3.25],
    [-2.92, -3.06, -2.94],
    [-11.75, -13.03, -11.7],
    [-9.48, -10.08, -9.87],
    [5.03, 3.49, 4.04],
    [18.89, 17.88, 18.3],
    [21.83, 20.95, 20.78],
    [11.83, 11.22, 11.75],
    [5.23, 4.73, 4.72],
    [0.0, 0.0, 0.0],
  ],
  chroma: [
    [-110.52, 25.61, 28.78],
    [14.96, 2.7, -151.66],
    [16.25, 9.92, 6.22],
    [12.18, -13.96, 12.25],
    [21.93, 30.63, -7.76],
    [-2.31, 1.7, 17.74],
    [12.15, 11.14, 19.78],
    [-4.26, -8.33, -10.96],
    [6.4, 19.64, 22.47],
    [-7.58, 7.81, -18.71],
    [6.9, -1.87, -0.86],
    [-1.57, 4.24, -15.35],
  ],
};

const acros = {
  tone: [
    [0, 0, 0],
    [-2.50, -2.50, -2.50],
    [-5.84, -5.84, -5.84],
    [-5.26, -5.26, -5.26],
    [-2.72, -2.72, -2.72],
    [-1.17, -1.17, -1.17],
    [0.47, 0.47, 0.47],
    [0.97, 0.97, 0.97],
    [2.11, 2.11, 2.11],
    [2.06, 2.06, 2.06],
    [0, 0, 0],
  ],
  chroma: [
    [8.34, 8.34, 8.34],
    [6.38, 6.38, 6.38],
    [5.97, 5.97, 5.97],
    [-1.60, -1.60, -1.60],
    [30.91, 30.91, 30.91],
    [0.84, 0.84, 0.84],
    [3.42, 3.42, 3.42],
    [-1.64, -1.64, -1.64],
    [4.57, 4.57, 4.57],
    [0.30, 0.30, 0.30],
    [-1.71, -1.71, -1.71],
    [-0.80, -0.80, -0.80],
  ],
};

const acrosRed = {
  tone: [
    [0.0, 0.0, 0.0],
    [-1.6, -1.6, -1.6],
    [-4.26, -4.26, -4.26],
    [-4.17, -4.17, -4.17],
    [-2.6, -2.6, -2.6],
    [-2.47, -2.47, -2.47],
    [-0.9, -0.9, -0.9],
    [2.11, 2.11, 2.11],
    [3.14, 3.14, 3.14],
    [2.11, 2.11, 2.11],
    [0.0, 0.0, 0.0],
  ],
  chroma: [
    [72.55, 72.55, 72.55],
    [-37.49, -37.49, -37.49],
    [-0.38, -0.38, -0.38],
    [9.23, 9.23, 9.23],
    [68.27, 68.27, 68.27],
    [23.03, 23.03, 23.03],
    [-44.96, -44.96, -44.96],
    [11.53, 11.53, 11.53],
    [-16.13, -16.13, -16.13],
    [-1.05, -1.05, -1.05],
    [-2.21, -2.21, -2.21],
    [0.89, 0.89, 0.89],
  ],
};

const sepia = {
  tone: [
    [0.0, 0.0, 0.0],
    [10.7, -1.19, -6.42],
    [18.84, -3.25, -17.26],
    [26.71, -5.22, -25.7],
    [24.35, -4.25, -23.48],
    [23.33, -4.91, -23.24],
    [22.6, -3.99, -22.13],
    [22.87, -3.62, -22.5],
    [16.93, -3.9, -16.41],
    [3.22, -4.68, -6.16],
    [0.0, 0.0, 0.0],
  ],
  chroma: [
    [3.32, -7.24, 2.08],
    [3.09, 6.69, 4.7],
    [10.17, 3.78, 6.71],
    [-8.8, 5.59, 19.22],
    [27.87, 17.65, 9.91],
    [5.48, 7.44, 4.86],
    [10.85, 6.16, 1.46],
    [-3.56, 7.39, -0.15],
    [2.88, 4.35, 10.97],
    [23.42, 11.67, 3.74],
    [2.34, 0.22, 1.55],
    [5.96, 1.36, 6.28],
  ],
};

function createFilmPreset(suffix, { tone, chroma }, getDelta = filmColorDelta) {
  return createPreset(suffix, rgb => getDelta(rgb, tone, chroma));
}

const photoPresets = {
  positive: createPreset("紀實正片", rgb => filmColorDelta(rgb, classicChromeTone, classicChromeChroma)),
  negative: createPreset("暖影負片", rgb => filmColorDelta(rgb, classicNegativeTone, classicNegativeChroma)),
  standard: createPreset("標準通用", rgb => filmColorDelta(rgb, proviaTone, proviaChroma)),
  "color-effect": createPreset("彩色效果", colorEffectDelta),
  velvia: createFilmPreset("濃彩風景", velvia),
  astia: createFilmPreset("柔光人像", astia),
  "reala-ace": createFilmPreset("清透日光", realaAce),
  "pro-neg-hi": createFilmPreset("深影人像", proNegHi),
  "pro-neg-std": createFilmPreset("柔階人像", proNegStd),
  "nostalgic-neg": createFilmPreset("琥珀相紙", nostalgicNeg),
  eterna: createFilmPreset("柔調電影", eterna),
  "eterna-bleach-bypass": createFilmPreset("銀灰電影", eternaBleachBypass),
  acros: createFilmPreset("銀鹽黑白", acros, monochromeFilmDelta),
  "acros-red": createFilmPreset("紅鏡黑白", acrosRed, monochromeFilmDelta),
  sepia: createFilmPreset("暖棕相紙", sepia, monochromeFilmDelta),
  "r-positive": createPreset("R正片", rgb => filmColorDelta(rgb, ricohPositiveTone, ricohPositiveChroma)),
  "r-negative": createPreset("R負片", rgb => filmColorDelta(rgb, ricohNegativeTone, ricohNegativeChroma)),
};
