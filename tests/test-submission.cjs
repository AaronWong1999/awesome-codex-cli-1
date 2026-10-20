const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { findSection, insertEntry, parseCommand } = require('../scripts/approve-submission.cjs');
const { fields, canonical, inspect, summarize, entry, criteria, gate } = require('../scripts/validate-submission.cjs');

const body = `### Display Name
Tool
### Category
Session Managers
### Link
https://github.com/example/tool
### Author Name
example
### Author Link
https://github.com/example
### Description
A Codex helper that manages sessions.
### Checklist
- [x] First
- [X] Second
- [x] Third
- [x] Fourth
`;

test('parses complete form including final field and CRLF', () => {
  assert.match(fields(body.replaceAll('\n', '\r\n')).Checklist, /Third/);
  const result = inspect(body, '');
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.repository, { owner: 'example', repo: 'tool' });
});
test('normalizes GitHub URLs and catches duplicate', () => {
  assert.equal(canonical('https://github.com/Example/Tool.git/'), 'github.com/example/tool');
  assert.equal(inspect(body, '[Tool](https://github.com/example/tool/)').changes.length, 1);
});
test('requires evidence links, missing fields and checked checklist', () => {
  const result = inspect('### Link\n_No response_\n', '');
  assert.ok(result.evidence.length >= 6);
  assert.equal(result.changes.length, 1);
});
test('does not treat low stars or age as a local rejection rule', () => {
  assert.deepEqual(inspect(body, '').changes, []);
});
test('meets criteria at 100 stars; age alone does not qualify', () => {
  assert.equal(criteria({ stars: 100 }).met, true);
  assert.equal(criteria({ stars: 99 }).met, false);
  const below = criteria({ stars: 3 });
  assert.equal(below.met, false);
  assert.match(below.reason, /3 stars < 100/);
});
test('rejects non-https links and out-of-range descriptions', () => {
  const bad = body.replace('https://github.com/example/tool', 'http://example.com/tool').replace('A Codex helper that manages sessions.', 'short');
  assert.equal(inspect(bad, '').changes.length, 2);
});
test('summarizes repository metadata and builds the entry line', () => {
  const info = summarize({
    name: 'tool', description: ' A  Codex\nhelper. ', stargazers_count: 120, archived: false,
    license: { spdx_id: 'MIT' }, created_at: '2025-01-02T00:00:00Z', pushed_at: '2026-03-04T00:00:00Z', topics: [],
  }, '');
  assert.equal(info.mentionsCodex, true);
  assert.equal(info.license, 'MIT');
  assert.equal(entry(inspect(body, '').data), '- [Tool](https://github.com/example/tool) - A Codex helper that manages sessions.');
});
test('flags the checked trap box without counting it as a checklist item', () => {
  const trap = '- [x] Do not check the following box - leave it unchecked. By checking this box, I admit that I am not reading any of these statements.\n';
  const three = body.replace('- [x] Fourth\n', '') + trap;
  const result = inspect(three, '');
  assert.equal(result.trapped, true);
  assert.equal(result.changes.length, 1);
  assert.equal(inspect(body + trap, '').changes.length, 0);
});

test('gate passes at 100 stars or 14 days and closes otherwise', () => {
  const now = Date.parse('2026-06-15T00:00:00Z');
  assert.equal(gate({ stars: 100, firstCommit: '2026-06-14T00:00:00Z', now }).ok, true);
  assert.equal(gate({ stars: 3, firstCommit: '2026-06-01T00:00:00Z', now }).ok, true);
  const closed = gate({ stars: 3, firstCommit: '2026-06-10T00:00:00Z', now });
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /5\.0 days < 14 and 3 stars < 100/);
});
test('warns on duplicate or test display names', () => {
  assert.equal(inspect(body, '- [Tool](https://example.com/other) - x').warnings.length, 1);
  assert.equal(inspect(body.replace('Tool', 'test'), '').warnings.length, 1);
  assert.deepEqual(inspect(body, '').warnings, []);
});
test('parses maintainer commands', () => {
  assert.deepEqual(parseCommand('/approve'), { command: 'approve', reason: '' });
  assert.deepEqual(parseCommand('/reject too niche'), { command: 'reject', reason: 'too niche' });
  assert.equal(parseCommand('please approve'), null);
});
test('inserts an entry after the last item of the matching section', () => {
  const readme = '## Tools\n\n### Sandboxes\n\n- [A](https://a.dev) - a\n- [B](https://b.dev) - b\n\n### Terminal\n\n- [C](https://c.dev) - c\n';
  const out = insertEntry(readme, 'Sandboxes', '- [N](https://n.dev) - n.');
  assert.match(out, /- \[B\].*\n- \[N\]\(https:\/\/n\.dev\) - n\.\n\n### Terminal/);
  assert.throws(() => insertEntry(readme, 'Missing', 'x'), /No README section/);
});
test('every Category option in the form resolves to a README section', () => {
  const form = fs.readFileSync('.github/ISSUE_TEMPLATE/resource.yml', 'utf8');
  const readme = fs.readFileSync('README.md', 'utf8');
  const options = [...form.match(/id: category[\s\S]*?validations/)[0].matchAll(/^\s+- "(.+)"$/gm)].map(m => m[1]);
  assert.ok(options.length > 20);
  for (const option of options) {
    const section = findSection(readme, option);
    assert.ok(section, `no README section for "${option}"`);
    assert.ok(section.lines.slice(section.start, section.end).some(line => /^- \[/.test(line)), `"${option}" has no list`);
  }
});
