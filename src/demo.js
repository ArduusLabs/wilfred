// Made-up rows covering every state, for `npm run demo` (design work and screenshots).
// WILFRED_DEMO=empty shows the empty board; WILFRED_DEMO=many adds idle sessions past the fold;
// WILFRED_DEMO=short leaves out a few rows, so the whole list fits one picture.
const SHORT_LEAVES_OUT = new Set(['local_demo-3', 'local_demo-8', 'local_demo-7']);

function demoRows(now, variant = process.env.WILFRED_DEMO) {
  const rows = allDemoRows(now, variant);
  return variant === 'short' ? rows.filter((r) => !SHORT_LEAVES_OUT.has(r.id)) : rows;
}

function allDemoRows(now, variant) {
  const min = 60 * 1000;
  const row = (r) => ({
    starred: false, quiet: false, seen: false, step: null, detail: '', project: 'billing-api', lastActivityAt: now,
    model: 'claude-opus-5-5', effort: 'high', permissionMode: 'default', branch: '', folder: '', parentId: '', parentTitle: '',
    completedTurns: 0, cost: null, ...r,
  });
  if (variant === 'empty') return [];
  const quiet = variant === 'many'
    ? ['Onboarding guide', 'Perf baseline', 'Dependency bumps', 'Invoice export', 'Login page copy', 'Retry policy'].map((title, i) =>
      row({ id: `local_demo-idle-${i}`, title, state: 'idle', seen: true, headline: 'Finished', since: now - (200 + i * 30) * min, project: 'billing-api' }))
    : [];
  return [
    row({ id: 'local_demo-1', title: 'Billing API', state: 'needs-you', starred: true, headline: 'Push the branch and open the PR?', detail: 'Gate passed on 02f5b3a7. Nothing pushed yet.', since: now - 3 * min, model: 'claude-fable-5-1', effort: 'max', permissionMode: 'auto', branch: 'claude/billing-retries', completedTurns: 18, cost: { usd: 4.11, tokens: 9.7e6, linesAdded: 78, linesRemoved: 12 }, context: { tokens: 583000, window: 1e6, pct: 58 } }),
    row({ id: 'local_demo-2', title: 'Docs site', state: 'working', headline: 'Running: Run the integration tests', step: { index: 3, total: 6, text: 'Update the API reference' }, detail: 'You asked: refresh the API reference', since: now - 12 * min, project: 'docs-site', branch: 'docs/api-reference', completedTurns: 7, cost: { usd: 1.2, tokens: 2.1e6, linesAdded: 240, linesRemoved: 31 }, context: { tokens: 68000, window: 200000, pct: 34 } }),
    row({ id: 'local_demo-9', title: 'Docs site: screenshots', state: 'new', headline: 'Six screenshots refreshed under docs/', since: now - 8 * min, project: 'docs-site', parentId: 'local_demo-2', parentTitle: 'Docs site', model: 'claude-sonnet-5-5', effort: 'medium', completedTurns: 3 }),
    row({ id: 'local_demo-10', title: 'Docs site: link check', state: 'working', headline: 'Running: Check every link in the reference', since: now - 2 * min, project: 'docs-site', parentId: 'local_demo-2', parentTitle: 'Docs site', model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'acceptEdits', completedTurns: 1 }),
    row({ id: 'local_demo-3', title: 'Data importer', state: 'working', background: true, headline: 'In background: Agent: Check the import totals', detail: 'Last update: 3 mappings fixed; tests green', since: now - 40 * min, project: '', completedTurns: 22, context: { tokens: 174000, window: 200000, pct: 87 } }),
    row({ id: 'local_demo-4', title: 'Infra drift check', state: 'needs-you', quiet: true, headline: 'Running: Apply the plan to staging', detail: 'No progress for 5 min. It may be waiting for your permission.', since: now - 6 * min, project: 'infra', effort: 'xhigh', permissionMode: 'bypassPermissions', branch: 'infra/staging-plan', context: { tokens: 23000, window: 200000, pct: 12 } }),
    row({ id: 'local_demo-5', title: 'Morning brief', state: 'new', headline: 'Brief saved to notes/today.md; two PRs need review', since: now - 95 * min, project: 'notes', parentTitle: 'Daily routines', completedTurns: 2 }),
    row({ id: 'local_demo-6', title: 'Nightly healthcheck', state: 'failed', headline: 'database login failed on staging', since: now - 20 * min, project: 'ops-scripts', completedTurns: 4 }),
    row({ id: 'local_demo-8', title: 'Changelog bot', state: 'working', headline: 'Reading what came back…', detail: 'Agent: list the merged pull requests', since: now - 1 * min, project: 'tooling', context: { tokens: 905000, window: 1e6, pct: 91 } }),
    row({ id: 'local_demo-7', title: 'Release notes', state: 'idle', seen: true, headline: 'Changelog drafted for 2.4', since: now - 150 * min, project: 'docs-site', completedTurns: 9 }),
    row({ id: 'local_demo-11', title: 'Retry policy', state: 'idle', stateWas: 'needs-you', snoozed: true, snoozedUntil: now + 25 * min, seen: true, headline: 'Keep the three-attempt default?', since: now - 30 * min, completedTurns: 5 }),
    ...quiet,
  ];
}

module.exports = { demoRows };
