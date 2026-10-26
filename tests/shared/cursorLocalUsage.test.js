'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { localNativeCoverage, readCursorLocalUsage } = require('../../src/shared/providers/cursor/localUsage');
const { readCursorLocalTurnUsage } = require('../../src/shared/providers/cursor/localSessions');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { readDailyHistoryArchive, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-observed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const time = day => new Date(2026, 9, day, 9).getTime();
  const log = path.join(dir, '.config/Cursor/logs/20261026T090000/window1/output_090000/cursor.hooks.log');
  const cacheDir = path.join(dir, '.config/tokscale/cursor-cache');
  const file = path.join(dir, '.config/tokscale/cursor-local-usage.json');
  const options = { homeDir: dir, env: {}, platform: 'linux', now: new Date(2026, 9, 26, 12) };
  function hooks(at = time(26), overrides = {}, target = log) {
    const row = { conversation_id: 'session', generation_id: 'turn', user_email: 'private@example.test',
      workspace_roots: ['/private/project'], model: 'selected-model', input_tokens: 30, output_tokens: 5,
      cache_read_tokens: 20, cache_write_tokens: 0, prompt: 'do not retain this prompt', ...overrides };
    const block = (timestamp, event) => `[${new Date(timestamp).toISOString()}] Running hook\nINPUT:\n${JSON.stringify({ ...row, hook_event_name: event }, null, 2)}\n\nOUTPUT:\n(empty)\n`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, block(at, 'beforeSubmitPrompt') + block(at + 2000, 'stop'));
  }
  function native(at, count = 35, archive = false) {
    const target = path.join(cacheDir, archive ? 'archive/usage.old.json' : 'usage.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ usageEventsDisplay: [{ timestamp: at, model: 'model',
      tokenUsage: { inputTokens: count } }] }));
  }
  return { dir, log, file, options, time, hooks, native, cacheDir };
}

test('complete local turns persist exact input plus output without prompts, owners or selected models', t => {
  const f = fixture(t); f.hooks();
  const [row] = readCursorLocalUsage(f.options);
  assert.equal(row.totalTokens, 35);
  assert.equal(row.inputTokens, 10);
  assert.equal(row.cacheReadTokens, 20);
  assert.equal(row.outputTokens, 5);
  assert.equal(row.model, 'unknown');
  assert.match(row.id, /^[a-f0-9]{64}$/);
  const saved = fs.readFileSync(f.file, 'utf8');
  assert.doesNotMatch(saved, /private|selected-model|session|turn|prompt|workspace|email/i);
  fs.unlinkSync(f.log);
  assert.deepEqual(readCursorLocalUsage(f.options), [row], 'rotation cannot retract observed usage');
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved, 'unchanged ticks do not rewrite the ledger');
});

test('duplicate hook executions in different windows count a generation once', t => {
  const f = fixture(t); f.hooks();
  f.hooks(f.time(26) + 100, {}, f.log.replace('window1', 'window2'));
  assert.equal(readCursorLocalTurnUsage(f.options).rows.length, 1);
  assert.equal(readCursorLocalUsage(f.options).length, 1);
});

test('conflicting counters retire a prior observation durably', t => {
  const f = fixture(t); f.hooks();
  assert.equal(readCursorLocalUsage(f.options).length, 1);
  f.hooks(f.time(26) + 100, { output_tokens: 6 }, f.log.replace('window1', 'window2'));
  assert.equal(readCursorLocalUsage(f.options).length, 0);
  fs.rmSync(path.join(f.dir, '.config/Cursor/logs'), { recursive: true });
  assert.equal(readCursorLocalUsage(f.options).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).conflicts.length, 1);
});

test('missing or conflicting ownership never produces an accounting observation', t => {
  const f = fixture(t); f.hooks(f.time(26), { user_email: '' });
  assert.equal(readCursorLocalUsage(f.options).length, 0);
  const raw = fs.readFileSync(f.log, 'utf8').replace('"user_email": ""', '"user_email": "one@example.test"');
  fs.writeFileSync(f.log, raw.replace(/"user_email": ""/g, '"user_email": "two@example.test"'));
  assert.equal(readCursorLocalUsage(f.options).length, 0);
});

test('incomplete counters and explicit zero counters do not invent consumption', t => {
  const f = fixture(t);
  f.hooks(f.time(26), { cache_read_tokens: undefined });
  f.hooks(f.time(26), { generation_id: 'zero', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 });
  assert.equal(readCursorLocalUsage(f.options).length, 0);
});

for (const archived of [false, true]) test(`native ${archived ? 'archived' : 'live'} usage owns its entire UTC day`, t => {
  const f = fixture(t); f.hooks(); f.hooks(f.time(24), { generation_id: 'older' });
  f.native(f.time(26) + 1000, 2, archived);
  const rows = readCursorLocalUsage(f.options);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventTime, f.time(24) + 2000);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).rows.length, 2, 'native precedence does not destroy observations');
});

for (const invalid of ['malformed', 'legacy', 'missing-schema']) test(`${invalid} native coverage blocks uncertain supplementation`, t => {
  const f = fixture(t); f.hooks(); fs.mkdirSync(f.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(f.cacheDir, invalid === 'legacy' ? 'usage.csv' : 'usage.json'),
    invalid === 'legacy' ? 'legacy,unknown' : invalid === 'malformed' ? '{bad' : '{}');
  assert.equal(localNativeCoverage(f.options).unavailable, true);
  assert.equal(readCursorLocalUsage(f.options).length, 0);
});

test('an explicit billing connection takes precedence and a cutoff only affects projection', t => {
  const f = fixture(t); f.hooks();
  assert.equal(readCursorLocalUsage({ ...f.options, cursorBillingAccounts: [{ accountId: 'selected' }] }).length, 0);
  assert.equal(readCursorLocalUsage({ ...f.options, nativeCoverageUnknown: true }).length, 0);
  assert.equal(readCursorLocalUsage({ ...f.options, allTimeSince: new Date(f.time(26) + 3000).toISOString() }).length, 0);
  assert.equal(readCursorLocalUsage(f.options).length, 1);
});

test('dated legacy CSV covers its dates without blocking unrelated recent days', t => {
  const f = fixture(t); f.hooks();
  fs.mkdirSync(path.join(f.cacheDir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(f.cacheDir, 'archive/usage-old.csv'),
    `Date,Model,Total Tokens\n"${new Date(f.time(24)).toISOString()}","old,model",35\n`);
  assert.equal(localNativeCoverage(f.options).unavailable, false);
  assert.equal(readCursorLocalUsage(f.options).length, 1);
  f.hooks(f.time(24), { generation_id: 'older' });
  assert.equal(readCursorLocalUsage(f.options).length, 1, 'the CSV day still takes native precedence');
});

test('a corrupt saved ledger fails without replacing the last file', t => {
  const f = fixture(t); f.hooks();
  fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, '{broken');
  assert.throws(() => readCursorLocalUsage(f.options));
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});

test('local accounting fills Today, Month, All Time and History outside native anchors', async t => {
  const f = fixture(t); f.hooks(); t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  let captured;
  const options = { ...f.options, clients: 'cursor,claude', deviceId: 'test', osInfo: {}, wslScanEnabled: false,
    codexLocalUsageEnabled: false, projectsEnabled: true, includeHistory: true,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: path.join(f.dir, 'history.json') },
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }),
    onAnchorComputed: value => { captured = value; } };
  const result = await collectUsageOnce(options);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(result[name].clients.cursor, 35); assert.equal(result[name].models.unknown, 35);
    assert.equal(result[name].unpricedTokens, 35); assert.equal(captured.windowsPeriods[name].totalTokens, 0);
  }
  assert.equal(result.history.summary.totalTokens, 35);
  assert.equal(Object.values(result.nativeProjects.today)[0].tokens, 35);
  const retained = graphFromDailyHistoryArchive(readDailyHistoryArchive({ path: path.join(f.dir, 'history.json') }));
  assert.deepEqual(retained.contributions, [], 'the separate ledger must stay out of generic history retention');
  const anchor = { dateKey: localTodayKey(f.options.now), ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  for (const targetClients of [['cursor'], ['claude'], []]) {
    const next = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients });
    assert.equal(next.month.clients.cursor, 35, 'warm and other-client ticks do not add the observation twice');
  }
  f.hooks(f.time(26) + 5000, { generation_id: 'next' });
  const changed = await collectUsageOnce({ ...options, includeHistory: false, todayOnlyAnchor: anchor, targetClients: ['claude'] });
  assert.equal(changed.today.clients.cursor, 70);
  assert.equal(changed.history.summary.totalTokens, 70, 'new local observations refresh History before its periodic interval');
});

test('historical native recovery rescans before removing local supplementation', async t => {
  const f = fixture(t); f.hooks(f.time(24)); t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  let captured;
  const options = { ...f.options, clients: 'cursor', deviceId: 'test', osInfo: {}, wslScanEnabled: false,
    historyEnabled: false, codexLocalUsageEnabled: false, runTokscale: async () => ({ entries: [] }),
    onAnchorComputed: value => { captured = value; } };
  const first = await collectUsageOnce(options); assert.equal(first.month.clients.cursor, 35);
  const anchor = { dateKey: localTodayKey(f.options.now), ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  f.native(f.time(24));
  const calls = [];
  const runTokscale = async ({ flags }) => { calls.push(flags); return { entries: flags.includes('--today') ? []
    : [{ client: 'cursor', model: 'actual-model', inputTokens: 35, totalTokens: 35, session: 'native' }] }; };
  const recovered = await collectUsageOnce({ ...options, runTokscale, todayOnlyAnchor: anchor });
  assert.equal(recovered.month.clients.cursor, 35); assert.equal(calls.length, 3);
  const refreshed = { dateKey: anchor.dateKey, ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  calls.length = 0;
  const stable = await collectUsageOnce({ ...options, runTokscale, todayOnlyAnchor: refreshed });
  assert.equal(stable.month.clients.cursor, 35); assert.equal(calls.length, 1);
});
