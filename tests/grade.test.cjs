const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../dist/grade.js"), "utf8");
const presets = vm.runInNewContext(`${source}\nphotoPresets;`);
const grayRamp = Uint8ClampedArray.from(
  Array.from({ length: 256 }, (_, value) => [value, value, value, 255]).flat(),
);

test("film presets maintain the order and endpoints of a gray ramp", () => {
  for (const [name, { grade }] of Object.entries(presets)) {
    const graded = grayRamp.slice();
    grade(graded, 1);
    assert.deepEqual(graded.slice(0, 4), grayRamp.slice(0, 4), name);
    assert.deepEqual(graded.slice(-4), grayRamp.slice(-4), name);

    let previous = 0;
    for (let i = 0; i < graded.length; i += 4) {
      const luma = 2126 * graded[i] + 7152 * graded[i + 1] + 722 * graded[i + 2];
      assert.ok(luma >= previous, `${name} reverses the ramp at ${i / 4}`);
      previous = luma;
    }
  }
});

test("color effect preserves neutral gray and blue, and deepens colorful reds and greens", () => {
  const { grade } = presets["color-effect"];
  const neutralAndBlue = new Uint8ClampedArray([...grayRamp, 40, 115, 212, 255]);
  const graded = neutralAndBlue.slice();
  grade(graded, 1);
  assert.deepEqual(graded, neutralAndBlue);

  const colors = new Uint8ClampedArray([220, 20, 20, 255, 20, 210, 20, 255]);
  grade(colors, 1);
  assert.ok(colors[0] < 220);
  assert.ok(colors[5] < 210);
});
