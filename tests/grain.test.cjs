const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const source = readFileSync(join(__dirname, "../dist/grain.js"), "utf8");
const { createFilmGrainField, applyFilmGrain, filmGrainSeed } = new Function(
  source + "\nreturn { createFilmGrainField, applyFilmGrain, filmGrainSeed };",
)();

const crop = { width: 6000, height: 4000 };
const seed = filmGrainSeed("example.jpg", crop.width, crop.height);

test("the same seed gives identical samples across export bands", () => {
  const width = 240;
  const height = 160;
  const read = createFilmGrainField(width, height, crop, seed, "fine");
  const whole = read(0, height);
  assert.deepEqual(read(30, 30), whole.slice(30 * width, 60 * width));
  assert.deepEqual(read(0, height), whole);
  const other = createFilmGrainField(width, height, crop, seed + 1, "fine");
  assert.notDeepEqual(other(0, height), whole);
});

test("a preview pixel averages the matching export pixel footprints", () => {
  const width = 320;
  const height = 214;
  for (const size of ["fine", "coarse"]) {
    const preview = createFilmGrainField(width, height, crop, seed, size)(0, height);
    const large = createFilmGrainField(2 * width, 2 * height, crop, seed, size)(0, 2 * height);
    let maxDifference = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width * 4 + x * 2;
        const average = (large[i] + large[i + 1] + large[i + width * 2] + large[i + width * 2 + 1]) / 4;
        maxDifference = Math.max(maxDifference, Math.abs(preview[y * width + x] - average));
      }
    }
    assert.ok(maxDifference < 0.00001, `footprint difference for ${size}: ${maxDifference}`);
  }
});

test("coarse grain has more correlated neighbors", () => {
  const width = 2400;
  const rmsNeighborDifference = (size) => {
    const field = createFilmGrainField(width, 1600, crop, seed, size)(0, 100);
    let total = 0;
    for (let i = 0; i < field.length - 1; i++) {
      if (i % width === width - 1) continue;
      total += (field[i + 1] - field[i]) ** 2;
    }
    return Math.sqrt(total / (100 * (width - 1)));
  };
  assert.ok(rmsNeighborDifference("coarse") < 0.8 * rmsNeighborDifference("fine"));
});

test("strength changes grain amplitude and leaves gray neutral", () => {
  const width = 240;
  const height = 160;
  const field = createFilmGrainField(width, height, crop, seed, "fine")(0, height);
  const original = new Uint8ClampedArray(field.length * 4).fill(128);
  const measure = (strength) => {
    const pixels = original.slice();
    applyFilmGrain(pixels, field, strength);
    let squaredDifference = 0;
    let difference = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      assert.equal(pixels[i], pixels[i + 1]);
      assert.equal(pixels[i], pixels[i + 2]);
      assert.equal(pixels[i + 3], 128);
      difference += pixels[i] - 128;
      squaredDifference += (pixels[i] - 128) ** 2;
    }
    assert.ok(Math.abs(difference / field.length) < 0.4);
    return Math.sqrt(squaredDifference / field.length);
  };
  assert.equal(measure("off"), 0);
  const weak = measure("weak");
  assert.ok(weak > 0);
  assert.ok(measure("strong") > 1.8 * weak);
});

test("transparent, black, white and fully saturated colors are protected", () => {
  const pixels = new Uint8ClampedArray([
    70, 30, 200, 0,
    0, 0, 0, 255,
    255, 255, 255, 255,
    255, 0, 0, 255,
  ]);
  const original = pixels.slice();
  applyFilmGrain(pixels, Float32Array.of(2, 2, -2, 2), "strong");
  assert.deepEqual(pixels, original);
});
