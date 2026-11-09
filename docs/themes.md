# Themes

Everything you see of Wilfred comes from CSS. A theme is one CSS file applied on top of
`src/renderer/style.css`, the structural layer, and it may restyle anything in it. The three built-in
themes live in `src/renderer/themes/`:

| File | Look |
| --- | --- |
| `day-book.css` | Paper and type; Wilfred's line as the heading, the state as a word in the margin (the default) |
| `bell-board.css` | Walnut and brass; each session is a lamp window that lights up; Wilfred stands on the board |
| `signal.css` | Flat colour blocks you can read from across the room, with the state as a word |

`themes/` inside Wilfred's settings folder (`%APPDATA%\Wilfred\themes` on Windows,
`~/Library/Application Support/Wilfred/themes` on a Mac, `~/.config/Wilfred/themes` on Linux;
**Open themes folder** in Settings > Appearance) holds a copy of each built-in theme, written there by Wilfred for you to edit, a `README.txt`, and a
copy of this page.
Edit a copy and Wilfred uses your version in place of the built-in (Settings > Appearance marks it
"edited"); copy one under a new name and it is a theme of its own there; delete a copy to get the
original back. Edits apply as you save. **Save current theme as a custom theme**, on the same
page, does the copy for you. A copy you haven't edited is refreshed when Wilfred's own changes; it
carries a marker in its first line that tells the two apart, so leave that line alone if you want
Wilfred to keep updating it.

A theme's id is its file name without `.css`: `bell-board` for a built-in one (an edited copy keeps
that id), `custom/My theme` for one of yours. That is what `--theme=<id>` takes and what Wilfred
remembers in its settings.

## What a theme can rely on

The page never changes its structure for a theme; it only toggles attributes and classes. A theme is
free to lay the pieces out any way it likes (every row is a CSS grid with named areas) and to hide
what it doesn't want.

```
#root                       .collapsed when the board is folded away
  #board                    [data-mood="alert" | "happy" | "working" | "sleep"]
    #board-head             drag handle
      .wordmark             "Wilfred"
      #chips > .chip        [data-state="needs-you" | "failed" | "working" | "new"], text "2 for you"
                            (or just "2" when the full labels don't fit; the full label is in title)
      #fold > svg           hides the board
    #summary                Wilfred's sentence, <b> for the emphasised part; [data-id] when it names one session
    #rows (ol)
      .row                  [data-state="needs-you" | "failed" | "working" | "new" | "idle"]
                            [data-depth="0" | "1"]: 1 for a side session, listed under the session that started it
                            .quiet       needs you, probably a permission prompt (less insistent)
                            .background  working: only background work is running
                            .transitional  working, between things ("Starting…", "Wrapping up…")
                            .starred     starred in the Claude app (style.css draws a star before the title; --star colours it)
                            .watched     the session you watch (an eye after the title; --watch colours it)
                            .snoozed     snoozed from the row menu: listed as idle, dimmed, asking for nothing
                            .unguarded   runs with no permission checks at all (its .mode is a warning)
                            .entering    for the first 300 ms after the row appears
        .lamp               empty <i>: the state mark (lamp, dot, spinner…), or nothing
        .state              the state as a word: "Needs you", "Failed", "Working", "In background", "Done", "Idle", "Snoozed"
        .title              the session's title
        .proj               the project folder, empty when unknown
        .ago                <time>: "3m", "1h 35m"
        .headline           the question, what it's doing, or the last update
        .step               [hidden] without a task list; <b> "3/6" and <span> the step; --done is 0…1
        .meta               [hidden] when there is nothing to say; what the session runs on, as four
                            <span>s: .model "Opus 5.5", .effort "max", .mode "auto mode", .context "34% context"
                            (empty ones are not drawn); the row gets .filling when the context is past half its window
                            and .full past 80% (style.css colours the reading --needs, then --failed)
        .kin                "2 side sessions" on a parent, "from <title>" on a side session whose parent is out of view; else empty
        .facts              the branch and what the session has used ("on claude/x · ≈ $4.11 at API prices · 9.7M tokens
                            · +78 −12 lines"), shown on hover by style.css; empty when unknown
        .detail             the longer update, shown on hover by style.css
      .more                 "+2 quiet sessions", when idle rows are left out
    #empty                  [hidden] unless there are no sessions
  #dock
    #bubble                 what Wilfred says when folded; [data-mood], [data-id], hidden when unfolded;
                            [data-watch="1"] while a session is watched, with an <i class="progress"> bar (--done 0…1) at its end
    #butler                 .alert | .happy | .working | .sleep
      #avatar-svg           the drawing: .figure .coat .lapel .shirt .collar .tie .knot .neck .ear .ear-in
                            .face .burn .hair .parting .hair-shine .cheeks .brows .lidlines .eyes .pupils
                            .glint .lids .bridge .nose .mouth .smile .mustache .bevel .frame, and the
                            gradients #a-bg #a-skin #a-hair #a-rim (their stops are coloured in style.css);
                            --tie and --tie-knot recolour his bow tie
      #avatar-img           your own picture, when you have one (hidden otherwise)
      #badge                the count on Wilfred: .failed or .new, else amber for needs-you; [hidden] at zero
      #zzz                  "zz" while he sleeps
```

`#root.dnd` is set while do not disturb is on: `style.css` then stops the hopping and the ringing, and
a chip `[data-state="dnd"]` ("Do not disturb", or "Quiet" when space is short) joins the header. A side
session's row is indented by `--nest` (22 px unless the theme says otherwise) with a bracket drawn in
`--rule`.

`html[data-theme]` carries the active theme's id, should a theme want to know.

`style.css` sets `--c` on every row and chip to the colour of its state, taken from these
variables, which every theme should define (for both colour schemes if it supports both):

| Variable | Used for |
| --- | --- |
| `--needs`, `--failed`, `--working`, `--new`, `--idle` | the five states |
| `--text`, `--soft`, `--muted` | the three levels of text |
| `--sans`, `--display`, `--serif` | body text, titles, Wilfred's voice |
| `--panel` | the surface colour; the settings window is painted with it |

The settings window dresses in the same variables (background, text, fonts, `--needs` as its accent),
so a theme styles it without doing anything. Its own class names are all its own, so none of the
board's rules reach it, with one exception on purpose: its title bar uses your `.wordmark` rule.

Light and dark: use `@media (prefers-color-scheme: light)` (or `dark`); the board follows the system.
`style.css` already turns decorative motion off under `prefers-reduced-motion`.

## What a theme can't do

The page runs under a strict content security policy and Wilfred has no network access, by design
(see `SECURITY.md`). So a theme can't load web fonts, remote images or `@import` anything. Use the
fonts installed on the machine (with fallbacks, as the built-in themes do); the page's own files can be
referenced relative to `src/renderer/`. A theme file over 1 MB is ignored.
