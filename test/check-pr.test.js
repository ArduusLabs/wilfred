const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../tools/check-pr');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '.github', 'pull_request_template.md'), 'utf8');
const check = (body, changed = []) => P.checkDescription(body, changed, TEMPLATE);
const tickAll = (text) => text.replace(/\[ \]/g, '[x]');
// The template, filled in the way a careful contributor would.
const filled = (text = TEMPLATE) => text
  .replace('## How I checked it', '## How I checked it\n\nnpm run coverage and npm run ui-check on Windows 11.')
  .replace('## What this changes, and why', '## What this changes, and why\n\nThe fold button keeps its place when the board is narrow. Fixes the report in the issue.');
const untick = (text, start) => text.replace(new RegExp(`\\[x\\] ${start}`), `[ ] ${start}`);
const GOOD = tickAll(filled());

test('the template as it comes says everything it still needs', () => {
  const problems = check(TEMPLATE);
  assert.equal(problems.length, 11);
  assert.match(problems[0], /"What this changes, and why" needs a few sentences of your own\. \(Text left inside the <!-- --> hints is not counted\.\)/);
  assert.match(problems[1], /"How I checked it" needs what you ran/);
  assert.match(problems[2], /Screenshots are missing: drag them into "Screenshots", or tick/);
  assert.equal(problems.filter((p) => p.startsWith('Not ticked: ')).length, 8);
});

test('filled in, every box ticked, nothing visible changed: it passes', () => {
  assert.deepEqual(check(GOOD, ['src/notify.js', 'test/notify.test.js']), []);
  // Windows line endings, as the web editor may send them
  assert.deepEqual(check(GOOD.replace(/\n/g, '\r\n')), []);
});

test('a change people can see needs pictures, whatever box is ticked', () => {
  let problems = check(GOOD, ['src/renderer/style.css']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Screenshots are missing, and this changes what people see \(src\/renderer\/style\.css\): drag before and after/);
  problems = check(GOOD, ['assets/tray.png', 'src/renderer/a.css', 'src/renderer/b.css', 'src/renderer/c.css', 'README.md']);
  assert.match(problems[0], /\(assets\/tray\.png, src\/renderer\/a\.css, src\/renderer\/b\.css, …\)/);

  const shots = [
    '![before](https://example.invalid/a.png)',
    '<img width="300" src="https://example.invalid/a.png">',
    'https://github.com/user-attachments/assets/0f0f0f0f-aaaa-bbbb-cccc-121212121212',
    'https://private-user-images.githubusercontent.com/1/2-3.png',
  ];
  const open = untick(GOOD, 'This change shows nothing');
  for (const shot of shots) {
    assert.deepEqual(check(open.replace('## Screenshots', `## Screenshots\n\n${shot}`), ['src/renderer/style.css']), [], shot);
  }
  // a picture in the wrong section doesn't count, and neither does one inside a comment
  assert.equal(check(open.replace('## How I checked it', `## How I checked it\n\n${shots[0]}`)).length, 1);
  assert.equal(check(open.replace('## Screenshots', `## Screenshots\n\n<!-- ${shots[0]} -->`)).length, 1);
});

test('a box left open needs its reason on the next line', () => {
  const line = '- [ ] No network code and no new packages';
  const open = untick(GOOD, 'No network code');
  assert.deepEqual(check(open), ['Not ticked: "No network code and no new packages". Tick it, or leave it open and write "Why not: …" on the line under it.']);
  for (const why of ['Why not: this adds the one package discussed in the issue.', '  **Why not:** this adds the one package discussed.', '  - Why not: this adds the one package discussed.', '> _Why not:_ this adds the one package discussed.']) {
    assert.deepEqual(check(open.replace(line, `${line}\n\n${why}`)), [], why);
  }
  assert.equal(check(open.replace(line, `${line}\n  Why not: n/a`)).length, 1);
});

test('every line of the checklist has to be there: deleting, striking out or rewriting one is not an answer', () => {
  const line = '- [x] No network code and no new packages';
  const missing = /The checklist line "No network code and no new packages" is missing: keep every line/;
  for (const dodge of ['', '- ~~[ ] No network code and no new packages~~', '+ [ ] No network code and no new packages', '1. [ ] No network code and no new packages', '- [] No network code and no new packages', '<!-- - [ ] No network code and no new packages -->', '- [x] ok', '- [x] ~~No network code and no new packages~~']) {
    const problems = check(GOOD.replace(line, dodge));
    assert.equal(problems.length, 1, dodge);
    assert.match(problems[0], missing, dodge);
  }
  // a comment left open hides the rest of the description, as it does on the page
  assert.equal(check(GOOD.replace('## Checklist', '## Checklist\n<!-- ')).length, 8);
  // spacing and marks may differ; the words may not
  assert.deepEqual(check(GOOD.replace('- [x] The version, `package-lock.json` and `.github/` are as I found them', '* [X]  The version, package-lock.json and **.github/** are as I found them')), []);
  // a description that threw the template away is told about every line of it
  assert.equal(check('fixes stuff').length, 3 + 8);
  assert.equal(check(null).length, 11);
  assert.equal(check(undefined, ['src/renderer/view.js']).length, 11);
  // boxes alone are not a description
  assert.equal(check(tickAll(TEMPLATE)).length, 2);
});

test('the line that says the lockfile and the workflows were left alone is held to the files changed', () => {
  const problems = check(GOOD, ['package-lock.json', '.github/workflows/test.yml', 'src/notify.js']);
  assert.deepEqual(problems, ['"The version, `package-lock.json` and `.github/` are as I found them" is ticked, but this changes package-lock.json, .github/workflows/test.yml. Leave it open and write "Why not: …" on the line under it.']);
  assert.match(check(GOOD, ['.github/a', '.github/b', '.github/c', '.github/d'])[0], /this changes \.github\/a, \.github\/b, \.github\/c, …\. Leave/);
  const line = '- [ ] The version, `package-lock.json` and `.github/` are as I found them';
  const explained = untick(GOOD, 'The version').replace(line, `${line}\n  Why not: the maintainers asked for the workflow change in the issue.`);
  assert.deepEqual(check(explained, ['.github/workflows/test.yml']), []);
  // package.json holds more than the version: a change there is for the reviewer to read
  assert.deepEqual(check(GOOD, ['package.json']), []);
});

test('sections and boxes are read as written', () => {
  assert.deepEqual(P.sections('intro\n## One\na\nb\n##  Two  \n\nc\n'), { one: 'a\nb\n', two: '\nc\n\n' });
  assert.deepEqual(P.sections(''), {});
  assert.deepEqual(P.boxes('- [x] a\n* [X] b\n  - [ ] c\nWhy not: because it cannot apply here\n- [ ] d\ntext'), [
    { text: 'a', ticked: true, why: false },
    { text: 'b', ticked: true, why: false },
    { text: 'c', ticked: false, why: true },
    { text: 'd', ticked: false, why: false },
  ]);
  assert.deepEqual(P.boxes('- [ ] last'), [{ text: 'last', ticked: false, why: false }]);
  assert.deepEqual(P.boxes(undefined), []);
  assert.equal(P.visibleText('a<!-- hidden\nmore -->b\r\nc'), 'ab\nc');
  assert.equal(P.visibleText(null), '');
  assert.equal(P.visibleText('a<!-- never closed\nb'), 'a');
});
