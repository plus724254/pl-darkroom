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
  const features = [
    redGreen, blueGreen, redGreen * centeredLuma, blueGreen * centeredLuma,
    redGreen ** 2, redGreen * blueGreen, blueGreen ** 2,
  ];

  return tone[index].map((value, channel) => {
    const offset = mix(value, tone[index + 1][channel], fraction);
    return features.reduce((sum, feature, i) => sum + feature * chroma[i][channel], offset);
  });
}

// Tone and chroma offsets are in 8-bit sRGB code values, fitted to aligned
// Standard / Film renders from GR III in-camera RAW development.
// https://ameblo.jp/pryce16/entry-12785797026.html
// Positive also uses the labeled GR III HDF harbor pair from the same exposure.
// https://pui-log.com/entry/2025/11/03/『GRⅣ』と『GRⅢ』の色の違いを見てみる
const ricohPositiveTone = [
  [0, 0, 0],
  [-6.58, -6.48, -7.65],
  [-11.36, -11.68, -13.90],
  [-18.13, -18.96, -17.72],
  [-19.19, -18.69, -16.08],
  [-12.83, -12.08, -11.76],
  [-7.26, -5.93, -6.02],
  [-3.47, -1.66, -1.98],
  [-0.23, -0.12, 0.76],
  [0.19, 0.70, 2.33],
  [0, 0, 0],
];
const ricohPositiveChroma = [
  [16.54, -1.00, -15.27],
  [-35.96, -19.24, -44.03],
  [4.27, -18.77, -21.41],
  [-7.02, 10.11, 24.24],
  [-4.47, -2.61, -1.41],
  [5.88, 5.81, 2.04],
  [-3.85, -5.26, -0.26],
];
const ricohNegativeTone = [
  [0, 0, 0],
  [0.10, -0.02, 0.13],
  [1.14, 0.99, 1.26],
  [5.61, 5.39, 5.58],
  [10.27, 10.34, 10.12],
  [13.94, 14.09, 13.57],
  [15.54, 15.62, 15.12],
  [13.41, 13.38, 13.47],
  [9.71, 9.67, 8.87],
  [5.79, 5.35, 6.39],
  [0, 0, 0],
];
const ricohNegativeChroma = [
  [31.17, 52.70, 12.69],
  [57.00, 52.60, -49.49],
  [-17.43, 14.04, 26.94],
  [-5.87, -12.81, -35.40],
  [-6.42, 50.62, 27.55],
  [-25.44, -28.05, -27.78],
  [24.03, 30.98, 30.80],
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
