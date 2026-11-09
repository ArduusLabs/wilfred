// Holds a pull request's description to the checklist in .github/pull_request_template.md
// (CONTRIBUTING.md says what each line means). CI runs it on every pull request, also the
// maintainers' own:
//
//   node tools/check-pr.js <event.json> <changed-files.txt>
//
// It reads three files and nothing else: the event GitHub hands the run (the description is in
// it), a list of the paths the pull request changes, one per line, and the template itself, whose
// checklist is the one every description must carry.
const fs = require('node:fs');
const path = require('node:path');

// A change under these is one a user can see: it needs pictures, whatever box is ticked.
const VISIBLE = [/^src\/renderer\//, /^assets\//];
const NOTHING_VISIBLE = /nothing new on screen/i;
// The line that promises these were left alone, and the paths it is about. (The version sits in
// package.json among other things, so a change there is for the reviewer to read.)
const LEFT_ALONE = /as i found them/i;
const MAINTAINERS = [/^package-lock\.json$/, /^\.github\//];
// A picture in the description: Markdown or HTML, or a file GitHub stored when it was dragged in.
const PICTURE = /!\[[^\]]*\]\([^)\s]+\)|<img\s[^>]*src=|https:\/\/github\.com\/user-attachments\/assets\/|https:\/\/[\w.-]*githubusercontent\.com\//i;
const WHY_NOT = /^why not:\s*\S.{9,}/i;

/**
 * The description without its HTML comments (the template's hints), line endings evened out. A
 * comment never closed hides everything after it, as it does on the page.
 */
function visibleText(body) {
  return String(body || '').replace(/\r/g, '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/** The description's sections: { 'heading in lower case': 'its text' } for every "## Heading". */
function sections(body) {
  const out = {};
  let name = '';
  for (const line of visibleText(body).split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) name = heading[1].toLowerCase();
    else if (name) out[name] = `${out[name] || ''}${line}\n`;
  }
  return out;
}

/**
 * The boxes in a piece of text: { text, ticked, why }. `why` is a "Why not: ..." line right under
 * the box, however it is dressed (a list item, a quote, bold).
 */
function boxes(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const box = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!box) return;
    const next = (lines.slice(i + 1).find((l) => l.trim()) || '').replace(/[*_>`]/g, '').replace(/^\s*-\s*/, '').trim();
    out.push({ text: box[2].trim(), ticked: box[1] !== ' ', why: WHY_NOT.test(next) });
  });
  return out;
}

// Two box texts are the same line when they read the same, whatever the spacing and the marks
// (but a line struck out is not the line).
const plain = (text) => text.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

/**
 * What is wrong with a pull request's description, given the paths it changes and the template
 * it was written from. [] when nothing is.
 */
function checkDescription(body, changed, template) {
  const problems = [];
  const s = sections(body);
  const find = (start) => Object.entries(s).find(([name]) => name.startsWith(start));
  const said = (start) => ((find(start) || [])[1] || '').replace(/^\s*[-*]\s+\[[ xX]\].*$/gm, '').trim();
  const hint = ' (Text left inside the <!-- --> hints is not counted.)';

  if (said('what this changes').length < 20) problems.push(`"What this changes, and why" needs a few sentences of your own.${hint}`);
  if (said('how i checked').length < 10) problems.push(`"How I checked it" needs what you ran, and on which system.${hint}`);

  const shots = (find('screenshots') || [])[1] || '';
  const picture = PICTURE.test(shots);
  const waived = boxes(shots).some((b) => b.ticked && NOTHING_VISIBLE.test(b.text));
  const visible = changed.filter((f) => VISIBLE.some((re) => re.test(f)));
  if (!picture && visible.length) {
    problems.push(`Screenshots are missing, and this changes what people see (${visible.slice(0, 3).join(', ')}${visible.length > 3 ? ', …' : ''}): drag before and after pictures into "Screenshots".`);
  } else if (!picture && !waived) {
    problems.push('Screenshots are missing: drag them into "Screenshots", or tick "This change shows nothing new on screen".');
  }

  // Every line of the template's checklist must still be there, ticked or answered: a line
  // deleted, struck out or rewritten is a line not answered.
  const written = boxes(visibleText(body));
  const touched = changed.filter((f) => MAINTAINERS.some((re) => re.test(f)));
  for (const line of boxes(sections(template).checklist)) {
    const box = written.find((b) => plain(b.text) === plain(line.text));
    if (!box) problems.push(`The checklist line "${line.text}" is missing: keep every line of the template's checklist as it is.`);
    else if (!box.ticked && !box.why) problems.push(`Not ticked: "${line.text}". Tick it, or leave it open and write "Why not: …" on the line under it.`);
    else if (box.ticked && LEFT_ALONE.test(line.text) && touched.length) problems.push(`"${line.text}" is ticked, but this changes ${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ', …' : ''}. Leave it open and write "Why not: …" on the line under it.`);
  }
  return problems;
}

module.exports = { checkDescription, sections, boxes, visibleText };

/* node:coverage disable */
if (require.main === module) {
  const [eventFile, changedFile] = process.argv.slice(2);
  if (!eventFile || !changedFile) {
    console.error('usage: node tools/check-pr.js <event.json> <changed-files.txt>');
    process.exit(2);
  }
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const changed = fs.readFileSync(changedFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const template = fs.readFileSync(path.join(__dirname, '..', '.github', 'pull_request_template.md'), 'utf8');
  const problems = checkDescription(event.pull_request && event.pull_request.body, changed, template);
  if (problems.length) {
    console.error(`This pull request's description needs ${problems.length === 1 ? 'one thing' : `${problems.length} things`} (edit it and the check runs again):\n${problems.map((p) => `  - ${p}`).join('\n')}\n\nCONTRIBUTING.md explains each rule.`);
    process.exit(1);
  }
  console.log('The description follows the checklist.');
}
/* node:coverage enable */
