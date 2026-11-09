// Unit tests for the console settings' schema handling (node --test).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePatch, resolve } from '../src/settings.mjs';

const schema = {
  desktop: {
    raiseNewWindows: { default: true, valid: (v) => typeof v === 'boolean', available: () => true },
    offHere: { default: 1, valid: Number.isInteger, available: () => false },
  },
};

test('resolve: saved values where valid, defaults otherwise', () => {
  assert.deepEqual(resolve(schema, {}), { desktop: { raiseNewWindows: true, offHere: 1 } });
  assert.deepEqual(resolve(schema, { desktop: { raiseNewWindows: false } }).desktop.raiseNewWindows, false);
  assert.equal(resolve(schema, { desktop: { raiseNewWindows: 'no' } }).desktop.raiseNewWindows, true);
  assert.equal(resolve(schema, { desktop: 'junk' }).desktop.raiseNewWindows, true);
  assert.equal(resolve(schema, { other: { x: 1 } }).other, undefined);
});

test('parsePatch: valid changes, HTTP errors for the rest', () => {
  assert.deepEqual(parsePatch(schema, { desktop: { raiseNewWindows: false } }), [['desktop', 'raiseNewWindows', false]]);
  assert.deepEqual(parsePatch(schema, {}), []);
  const status = (patch) => {
    try {
      parsePatch(schema, patch);
    } catch (err) {
      return err.status;
    }
    return 200;
  };
  assert.equal(status(null), 400);
  assert.equal(status([]), 400);
  assert.equal(status({ nope: {} }), 400);
  assert.equal(status({ desktop: true }), 400);
  assert.equal(status({ desktop: { nope: 1 } }), 400);
  assert.equal(status({ desktop: { raiseNewWindows: 'false' } }), 400);
  assert.equal(status({ desktop: { offHere: 2 } }), 409);
  assert.equal(status(JSON.parse('{"__proto__": {"raiseNewWindows": false}}')), 400); // own key, unknown section
});
