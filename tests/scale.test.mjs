import test from "node:test";
import assert from "node:assert/strict";
import { SCALES, DEFAULT_SCALE, applyScale, checkScale, scaleOf } from "../src/scale.js";

test("the scales run in order from 50% to 200%, and the default adds nothing to the browser's own size", () => {
  assert.equal(DEFAULT_SCALE, 100);
  assert.ok(SCALES.includes(DEFAULT_SCALE));
  assert.deepEqual([...SCALES].sort((a, b) => a - b), [...SCALES]);
  assert.equal(SCALES[0], 50);
  assert.equal(SCALES.at(-1), 200);
});

test("only a scale of the list is taken", () => {
  for (const scale of SCALES) assert.equal(checkScale(scale), scale);
  for (const bad of [0, -100, 33, 1000, 1.5, NaN, Infinity, "150", "150%", "", null, undefined, {}, [150]])
    assert.throws(() => checkScale(bad), /Choose a scale/, String(bad));
});

test("a stored scale off the list reads as the default, so a broken value cannot hide the interface", () => {
  assert.equal(scaleOf(150), 150);
  // Settings saved before the scale existed have none.
  assert.equal(scaleOf(undefined), DEFAULT_SCALE);
  for (const bad of [0, 33, "150", null, {}]) assert.equal(scaleOf(bad), DEFAULT_SCALE);
});

// fakeRoot records what a page's root element is given.
function fakeRoot() {
  const set = {};
  return { set, style: { setProperty: (name, value) => (set[name] = value) } };
}

test("a page takes the scale as a factor of its stylesheet", () => {
  const root = fakeRoot();
  applyScale(root, 150);
  assert.deepEqual(root.set, { "--scale": "1.5" });
  applyScale(root, 67);
  assert.deepEqual(root.set, { "--scale": "0.67" });
  applyScale(root, 100);
  assert.deepEqual(root.set, { "--scale": "1" });
});

test("a page falls back to the default rather than put a value off the list in its stylesheet", () => {
  const root = fakeRoot();
  applyScale(root, "2; background: url(https://evil.example/x)");
  assert.deepEqual(root.set, { "--scale": "1" });
  applyScale(root, undefined);
  assert.deepEqual(root.set, { "--scale": "1" });
});
