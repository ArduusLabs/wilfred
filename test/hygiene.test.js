// This is a public repository: nothing in it may carry a real user folder (which carries a real name).
// Example paths use the user "me" (/Users/me, /home/me); anything else fails here before it ships.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);
const TEXT = /\.(js|json|md|html|css|yml|yaml|cmd|command|sh|txt)$/;
const USER_FOLDER = /[A-Za-z]:[\\/]Users[\\/](?!me\b)|\/Users\/(?!me\b)|\/home\/(?!me\b)/;

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(full);
    } else if (TEXT.test(entry.name) && full !== __filename) {
      yield full;
    }
  }
}

test('no file in the repository names a real user folder', () => {
  const offenders = [];
  for (const file of files(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    const m = USER_FOLDER.exec(text);
    if (m) offenders.push(`${path.relative(ROOT, file)}: ${text.slice(Math.max(0, m.index - 20), m.index + 40).replace(/\s+/g, ' ')}`);
  }
  assert.deepEqual(offenders, []);
});
