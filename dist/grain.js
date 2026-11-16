"use strict";

const defaultFilmGrain = { strength: "off", size: "fine" };
const fineFilmGrain = { strength: "weak", size: "fine" };
const filmGrainProfiles = {
  none: defaultFilmGrain,
  positive: fineFilmGrain,
  negative: fineFilmGrain,
  standard: defaultFilmGrain,
  "color-effect": defaultFilmGrain,
  "r-positive": defaultFilmGrain,
  "r-negative": fineFilmGrain,
};

const FILM_GRAIN_REFERENCE_EDGE = 2400;
const filmGrainSpacing = { fine: 1.5, coarse: 3 };
const filmGrainIntensity = { weak: 0.024, strong: 0.052 };
const filmGrainResponse = [[0, 0.55], [0.1, 0.85], [0.3, 1], [0.7, 1], [0.9, 0.8], [1, 0.45]];
const GRAIN_COLOR_STEPS = 16384;
let grainTables;

function mixGrainBits(value) {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function filmGrainSeed(name, width, height) {
  let seed = 2166136261;
  for (let i = 0; i < name.length; i++) seed = Math.imul(seed ^ name.charCodeAt(i), 16777619);
  return mixGrainBits(seed ^ Math.imul(width, 0x9e3779b1) ^ height);
}

function getGrainTables() {
  if (grainTables) return grainTables;
  const gaussian = Float32Array.from({ length: 4096 }, (_, index) => {
    const u = (mixGrainBits(index * 2) + 0.5) / 4294967296;
    const v = (mixGrainBits(index * 2 + 1) + 0.5) / 4294967296;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  });
  const mean = gaussian.reduce((sum, value) => sum + value, 0) / gaussian.length;
  const rms = Math.sqrt(gaussian.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gaussian.length);
  // Linear interpolation averages neighboring samples on both axes. Normalize its RMS
  // at reference scale and let the pixel footprint naturally soften smaller renders.
  for (let i = 0; i < gaussian.length; i++) gaussian[i] = 1.5 * (gaussian[i] - mean) / rms;

  const linear = Float32Array.from({ length: 256 }, (_, index) => {
    const value = index / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const encoded = new Uint8ClampedArray(GRAIN_COLOR_STEPS + 1);
  const amplitude = new Float32Array(GRAIN_COLOR_STEPS + 1);
  let segment = 0;
  for (let i = 0; i <= GRAIN_COLOR_STEPS; i++) {
    const value = i / GRAIN_COLOR_STEPS;
    encoded[i] = 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
    if (value > filmGrainResponse[segment + 1][0]) segment++;
    const [left, low] = filmGrainResponse[segment];
    const [right, high] = filmGrainResponse[segment + 1];
    const t = (value - left) / (right - left);
    amplitude[i] = (0.06 + Math.sqrt(value)) * (low + (high - low) * t * t * (3 - 2 * t));
  }
  grainTables = { gaussian, linear, encoded, amplitude };
  return grainTables;
}

// Integral of the linear interpolation kernel centered at a lattice sample.
function grainKernelIntegral(x) {
  if (x <= -1) return 0;
  if (x < 0) return (x + 1) ** 2 / 2;
  if (x < 1) return 1 - (1 - x) ** 2 / 2;
  return 1;
}

function grainAxisWeights(length, extent) {
  const step = extent / length;
  return Array.from({ length }, (_, i) => {
    const left = i * step;
    const right = (i + 1) * step;
    const start = Math.floor(left);
    const weights = new Float32Array(Math.ceil(right) - start + 1);
    for (let j = 0; j < weights.length; j++) {
      const position = start + j;
      weights[j] = (grainKernelIntegral(right - position) - grainKernelIntegral(left - position)) / step;
    }
    return { start, weights };
  });
}

function createFilmGrainField(width, height, crop, seed, size) {
  // Map each output pixel to its footprint in the same cropped image coordinates.
  const referenceScale = FILM_GRAIN_REFERENCE_EDGE / Math.max(crop.width, crop.height) / filmGrainSpacing[size];
  const columns = grainAxisWeights(width, crop.width * referenceScale);
  const rows = grainAxisWeights(height, crop.height * referenceScale);
  const { gaussian } = getGrainTables();
  const projectedRows = new Map();
  const rowBuffer = new Float32Array(columns.at(-1).start + columns.at(-1).weights.length);

  return (top, rowCount, output = new Float32Array(width * rowCount)) => {
    output.fill(0, 0, width * rowCount);
    for (let y = top; y < top + rowCount; y++) {
      const { start, weights } = rows[y];
      for (const row of projectedRows.keys()) {
        if (row < start || row >= start + weights.length) projectedRows.delete(row);
      }
      const offset = (y - top) * width;
      for (let j = 0; j < weights.length; j++) {
        const row = start + j;
        const weight = weights[j];
        if (!weight) continue;
        let projected = projectedRows.get(row);
        if (!projected) {
          const rowSeed = mixGrainBits(seed ^ Math.imul(row, 0x85ebca6b));
          for (let i = 0; i < rowBuffer.length; i++) {
            rowBuffer[i] = gaussian[mixGrainBits(rowSeed ^ Math.imul(i, 0x9e3779b1)) & (gaussian.length - 1)];
          }
          projected = new Float32Array(width);
          for (let x = 0; x < width; x++) {
            const { start, weights } = columns[x];
            let sample = 0;
            for (let i = 0; i < weights.length; i++) sample += weights[i] * rowBuffer[start + i];
            projected[x] = sample;
          }
          projectedRows.set(row, projected);
        }
        for (let x = 0; x < width; x++) output[offset + x] += weight * projected[x];
      }
    }
    return output;
  };
}

function applyFilmGrain(pixels, field, strength) {
  const intensity = filmGrainIntensity[strength];
  if (!intensity) return;
  const { linear, encoded, amplitude } = getGrainTables();
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const red = linear[pixels[i]];
    const green = linear[pixels[i + 1]];
    const blue = linear[pixels[i + 2]];
    const peak = Math.max(red, green, blue);
    if (!peak || peak === 1) continue;

    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    // Bound the same gain in both directions to preserve hue and avoid clipping bias.
    const limit = Math.min(1, (1 - peak) / peak);
    const delta = field[i / 4] * intensity * amplitude[Math.round(luma * GRAIN_COLOR_STEPS)];
    const gain = 1 + Math.max(-limit, Math.min(limit, delta / luma));
    pixels[i] = encoded[Math.round(red * gain * GRAIN_COLOR_STEPS)];
    pixels[i + 1] = encoded[Math.round(green * gain * GRAIN_COLOR_STEPS)];
    pixels[i + 2] = encoded[Math.round(blue * gain * GRAIN_COLOR_STEPS)];
  }
}
