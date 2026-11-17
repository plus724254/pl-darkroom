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
  [0, 0, 0],
  [2.07, 1.26, 1.42],
  [4.13, 2.66, 2.92],
  [7.33, 8.35, 8.03],
  [11.44, 12.42, 12.27],
  [14.15, 15.14, 15.07],
  [15.08, 15.67, 15.30],
  [13.89, 13.59, 12.73],
  [9.85, 8.04, 6.42],
  [4.98, 3.52, 6.41],
  [0, 0, 0],
];
const ricohNegativeChroma = [
  [20.09, 29.84, 8.98],
  [38.36, 31.63, -37.73],
  [-22.48, -1.89, 18.99],
  [-1.70, -10.92, -30.91],
  [1.67, 25.74, 7.30],
  [-21.67, -15.57, -8.66],
  [36.86, 37.85, 18.37],
  [6.10, 14.73, 0.96],
  [15.80, 19.05, -12.48],
  [-0.33, -4.15, 0.03],
  [2.86, 2.54, 1.10],
  [-8.96, -12.12, -1.04],
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
  [0, 0, 0],
  [-0.96, 1.41, -0.94],
  [-5.17, -0.30, -1.64],
  [-11.49, -8.39, -7.92],
  [-8.80, -6.05, -5.26],
  [8.83, 5.28, 4.80],
  [28.14, 18.08, 12.49],
  [29.66, 20.23, 15.63],
  [18.97, 10.69, 6.30],
  [10.25, 4.99, 3.05],
  [0, 0, 0],
];
const classicNegativeChroma = [
  [-36.64, 0.54, -38.44],
  [25.60, 30.10, -69.23],
  [-17.83, -27.61, -14.45],
  [-0.55, -5.20, 2.10],
  [19.30, 6.18, -0.07],
  [-49.58, -20.59, -22.53],
  [0.49, 8.48, 22.81],
];

const proviaTone = [
  [0, 0, 0],
  [-2.32, -2.98, -2.72],
  [-2.69, -3.82, -3.62],
  [-1.47, -2.55, -3.52],
  [-1.14, -0.17, -1.82],
  [-0.49, -0.58, 0.28],
  [0.28, -0.38, -0.27],
  [-0.22, -0.67, -0.23],
  [-0.75, -1.28, -1.39],
  [-0.93, -1.40, -0.44],
  [0, 0, 0],
];
const proviaChroma = [
  [46.49, 2.95, -16.83],
  [-2.43, 2.13, 41.75],
  [-26.03, 7.55, 11.58],
  [-9.68, 9.73, -16.45],
  [-31.06, -14.37, -4.16],
  [-23.44, 2.44, -11.94],
  [-16.74, -0.49, -13.73],
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

const photoPresets = {
  positive: createPreset("經典正片", rgb => filmColorDelta(rgb, classicChromeTone, classicChromeChroma)),
  negative: createPreset("經典負片", rgb => filmColorDelta(rgb, classicNegativeTone, classicNegativeChroma)),
  standard: createPreset("標準通用", rgb => filmColorDelta(rgb, proviaTone, proviaChroma)),
  "color-effect": createPreset("彩色效果", colorEffectDelta),
  "r-positive": createPreset("R正片", rgb => filmColorDelta(rgb, ricohPositiveTone, ricohPositiveChroma)),
  "r-negative": createPreset("R負片", rgb => filmColorDelta(rgb, ricohNegativeTone, ricohNegativeChroma)),
};
