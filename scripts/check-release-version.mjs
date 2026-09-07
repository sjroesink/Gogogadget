import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Use a release tag such as v0.1.8');
const version = tag.slice(1);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const cargoVersion = (file) => readFileSync(file, 'utf8').match(
  file.endsWith('.lock')
    ? /\[\[package\]\]\s+name = "gogogadget"\s+version = "([^"]+)"/
    : /\[package\][\s\S]*?\nversion = "([^"]+)"/,
)?.[1];
const versions = {
  'package.json': json('package.json').version,
  'package-lock.json': json('package-lock.json').version,
  'package-lock.json root package': json('package-lock.json').packages[''].version,
  'src-tauri/tauri.conf.json': json('src-tauri/tauri.conf.json').version,
  'src-tauri/Cargo.toml': cargoVersion('src-tauri/Cargo.toml'),
  'src-tauri/Cargo.lock': cargoVersion('src-tauri/Cargo.lock'),
};
for (const [file, actual] of Object.entries(versions)) {
  assert.equal(actual, version, `${file} must match tag ${tag}`);
}
console.log(`Release ${tag}: all package versions match.`);
