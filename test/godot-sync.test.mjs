import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// The Godot sample project can only load res:// files, so it keeps copies of the published scripts.
for (const name of ['YHEventNode.gd', 'YHAnimationBinder.gd']) {
  test(`examples/godot/${name} is identical to the published src/adapters/godot/${name}`, () => {
    assert.equal(read(`../examples/godot/${name}`), read(`../src/adapters/godot/${name}`));
  });
}
