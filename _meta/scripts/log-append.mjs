// Shared helper: append one line to the vault's append-only automation log.
// Never rewrites _meta/log.md — only ever appends. Import and call from any
// script that mutates the vault or an external store on its behalf.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(HERE, '..', 'log.md');

export function appendLog(source, summary) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `${stamp} · ${source} · ${summary}\n`;
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, '# Automation Log\n\n> Append-only — never rewritten. One line per automation run or error.\n\n');
  }
  fs.appendFileSync(LOG_FILE, line);
}
