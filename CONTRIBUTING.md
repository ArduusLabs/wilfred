# Contributing to Wilfred

Thank you for wanting to. Wilfred is small on purpose, and two promises shape every change: he has
**no network access** and **no dependencies but Electron** (see [SECURITY.md](SECURITY.md)). A pull
request that keeps both, is green, and shows what it changes will get a quick answer.

For anything larger than a fix, open an issue first and say what you have in mind. It saves you
building something that doesn't fit.

## Set up

You need [Node.js](https://nodejs.org) 22.12 or newer.

```bash
git clone https://github.com/ArduusLabs/wilfred.git
cd wilfred
npm install
npm run demo
```

`npm run demo` starts Wilfred on made-up sessions, with settings of its own, so you can work on him
without the Claude app and without touching your real setup.

## The checks

Run these before you open a pull request. CI runs the same ones: the tests on Windows, macOS and
Linux, the UI check on Windows (and on the other two as a trial, until it has been seen passing
there).

| Command | What it does |
| --- | --- |
| `npm run coverage` | The unit tests. Fails under 100% line, branch and function coverage |
| `npm run check-isolation` | Fails on network code, a new package, or a CI workflow that could write |
| `npm run ui-check` | Starts the real app on the demo, looks at it, and saves pictures |

`npm run ui-check` moves the pointer over the board, folds it, opens Settings from the menu and
goes through every theme in light and dark. It holds what it sees to a few rules (every row is
there, the line that says what a session runs on is readable, nothing is cut off, every control
has a name) and saves a
picture of each state. It prints where the pictures went; `npm run ui-check -- --out=<folder>`
puts them where you like. Wilfred appears on your screen for about half a minute while it runs.

## The rules for a pull request

Every pull request, the maintainers' own included, follows these. The description template has
them as a checklist, and a check in CI reads your description and says what is missing.

1. **CI is fully green.** All of it: the tests on three systems, the isolation check, the UI check
   and the description check. A red run is not reviewed. (One exception for now: the UI check on
   macOS and Linux is a trial until it has been seen passing there. Those two may show red, and
   don't count.)
2. **Screenshots for anything a person can see.** Before and after, dragged into the description.
   If the board or Settings look different, show all three themes in light and dark; the pictures
   `npm run ui-check` saves are exactly that set, and CI keeps its own copy with each run (under
   "Artifacts"). A change under `src/renderer/` or `assets/` always needs them. Use the demo:
   never a picture of your real sessions.
3. **One change, as small as it can be.** A fix and a refactor are two pull requests.
4. **What is new has a test.** Coverage is 100% and stays there. Logic goes into the modules the
   tests can load; `src/main.js` only wires things together.
5. **No network code, no new packages.** `npm run check-isolation` enforces it. If you believe a
   package is truly needed, open an issue first; expect the answer to be no.
6. **The version, the lockfile and `.github/` stay as they are.** A change of version publishes a
   release, and the workflows are part of what keeps Wilfred offline. The maintainers change those;
   if yours must, leave the box open and say why.
7. **Docs move with the code.** The README for what a user sees, `docs/themes.md` for anything a
   theme can style, `SECURITY.md` for anything Wilfred reads, writes or opens.
8. **Nothing personal.** No real names, user folders, session titles or secrets in code, tests,
   fixtures or pictures. The made-up user in tests is `me`.
9. **You understand every line.** AI tools are welcome; you answer for what they wrote, and you
   describe the change in your own words.

A box you can't tick is fine. Leave it open and write `Why not:` and your reason on the line under
it; the check accepts that, and a person reads it.

## How the look is built

Everything visible is CSS: `src/renderer/style.css` is the structure, and each theme is one file in
`src/renderer/themes/`. [docs/themes.md](docs/themes.md) is the contract a theme can rely on, so a
change to the page's structure is a change to that file too. Check a visual change in all three
themes, light and dark, with the keyboard alone, and with reduced motion switched on in your
system.

## Reporting a security problem

Not in a public issue, please: [SECURITY.md](SECURITY.md) says how.

## Licence

Wilfred is MIT licensed. By contributing you agree that your contribution is too.
