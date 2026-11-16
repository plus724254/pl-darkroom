"use strict";

// Adjust tone and saturation in sRGB, then add a tint weighted by tonal range.
function toneDelta(rgb, { contrast, saturation, shadows, highlights }) {
  const [red, green, blue] = rgb;
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const tone = contrast * luma * (1 - luma) * (2 * luma - 1);
  const shadowWeight = (1 - luma) ** 2;
  const highlightWeight = luma ** 2;

  return rgb.map((channel, i) => 255 * (
    tone + (saturation - 1) * (channel - luma)
    + shadows[i] * shadowWeight + highlights[i] * highlightWeight
  ));
}

function colorEffectDelta([red, green, blue]) {
  const warmest = Math.max(red, green);
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const colorWeight = Math.max(0, chroma - 0.18);
  const hueWeight = Math.max(0, warmest - blue);
  const depth = 255 * 0.82 * colorWeight * hueWeight * (1 - 0.55 * warmest);

  return [-depth * red, -depth * green, -depth * (blue + 0.25)];
}

// Preview and export share the same interpolated color grid.

const COLOR_GRID_STEPS = 16;
const COLOR_GRID_SIDE = COLOR_GRID_STEPS + 1;
const GREEN_STRIDE = 3 * COLOR_GRID_SIDE;
const BLUE_STRIDE = GREEN_STRIDE * COLOR_GRID_SIDE;

function buildColorGrid(getDelta, protectExtremes) {
  const grid = new Float32Array(BLUE_STRIDE * COLOR_GRID_SIDE);
  let i = 0;
  for (let b = 0; b <= COLOR_GRID_STEPS; b++) {
    for (let g = 0; g <= COLOR_GRID_STEPS; g++) {
      for (let r = 0; r <= COLOR_GRID_STEPS; r++) {
        const rgb = [r, g, b].map(value => value / COLOR_GRID_STEPS);
        const edgeWeight = protectExtremes
          ? Math.min(1, 10 * Math.max(...rgb), 10 * (1 - Math.min(...rgb)))
          : 1;
        for (const delta of getDelta(rgb)) grid[i++] = delta * edgeWeight;
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

function createPreset(suffix, getDelta, { protectExtremes = true } = {}) {
  const grid = buildColorGrid(getDelta, protectExtremes);
  return { grade: (pixels, strength) => applyColorGrid(pixels, strength, grid), suffix };
}

const RICOH_TONE_LEVELS = [0, 16, 32, 64, 96, 128, 160, 192, 224, 240, 255];

function ricohColorDelta([red, green, blue], tone, chroma) {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const code = luma * 255;
  let index = 0;
  while (index < RICOH_TONE_LEVELS.length - 2 && code > RICOH_TONE_LEVELS[index + 1]) index++;
  const lower = RICOH_TONE_LEVELS[index];
  const fraction = (code - lower) / (RICOH_TONE_LEVELS[index + 1] - lower);

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

const photoPresets = {
  positive: createPreset("經典正片", rgb => toneDelta(rgb, {
    contrast: 0.32,
    saturation: 0.76,
    shadows: [-0.025, 0.008, 0.043],
    highlights: [0.024, 0.010, -0.015],
  })),
  negative: createPreset("經典負片", rgb => toneDelta(rgb, {
    contrast: 0.92,
    saturation: 0.92,
    shadows: [-0.046, 0.035, 0.023],
    highlights: [0.049, -0.033, 0.021],
  })),
  standard: createPreset("標準通用", rgb => toneDelta(rgb, {
    contrast: 0.22,
    saturation: 1.06,
    shadows: [0, 0, 0],
    highlights: [0, 0, 0],
  })),
  "color-effect": createPreset("彩色效果", colorEffectDelta),
  "r-positive": createPreset(
    "R正片", rgb => ricohColorDelta(rgb, ricohPositiveTone, ricohPositiveChroma), { protectExtremes: false },
  ),
  "r-negative": createPreset(
    "R負片", rgb => ricohColorDelta(rgb, ricohNegativeTone, ricohNegativeChroma), { protectExtremes: false },
  ),
};
