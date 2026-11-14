import fs from 'node:fs';
import { isObject } from './settings-schema.mjs';

export function readSettings(file, warn = () => {}) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(saved)) return saved;
    warn(`${file} is not a JSON object; using the defaults`);
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`${file}: ${err.message}; using the defaults`);
  }
  return {};
}

export function writeSettings(file, saved) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}
