import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Each run starts from an empty coverage store.
export default function globalSetup() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.nyc_output');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}
