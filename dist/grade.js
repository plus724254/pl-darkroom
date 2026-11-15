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

function buildColorGrid(getDelta) {
  const grid = new Float32Array(BLUE_STRIDE * COLOR_GRID_SIDE);
  let i = 0;
  for (let b = 0; b <= COLOR_GRID_STEPS; b++) {
    for (let g = 0; g <= COLOR_GRID_STEPS; g++) {
      for (let r = 0; r <= COLOR_GRID_STEPS; r++) {
        const rgb = [r, g, b].map(value => value / COLOR_GRID_STEPS);
        const edgeWeight = Math.min(1, 10 * Math.max(...rgb), 10 * (1 - Math.min(...rgb)));
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

function createPreset(suffix, getDelta) {
  const grid = buildColorGrid(getDelta);
  return { grade: (pixels, strength) => applyColorGrid(pixels, strength, grid), suffix };
}

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
};
