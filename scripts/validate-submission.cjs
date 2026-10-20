const fs = require('node:fs');

const LABELS = {
  'resource-submission': ['0366d6', 'Resource proposed for inclusion'],
  correction: ['5319e7', 'Correction to an existing entry'],
  'validation-pending': ['ededed', 'Awaiting automated checks'],
  'validation-passed': ['0e8a16', 'Basic checks passed; not approval'],
  'needs-evidence': ['fbca04', 'Required submission evidence is missing'],
  'needs-changes': ['d93f0b', 'Basic submission checks need attention'],
  'manual-review': ['c5def5', 'Needs maintainer review'],
  'auto-closed': ['b60205', 'Closed automatically: did not meet the submission conditions'],
};
const STATUS = ['validation-pending', 'validation-passed', 'needs-evidence', 'needs-changes', 'manual-review'];
const MARKER = '<!-- submission-validation -->';
const MIN_STARS = 100;
const MIN_AGE_DAYS = 14;
const REQUIRED = ['Display Name', 'Category', 'Link', 'Author Name', 'Author Link', 'Description'];
const CHECKS = 4;
const TRAP = /^- \[[xX]\] Do not check the following box/m;

function fields(body) {
  const result = {};
  for (const match of body.matchAll(/^### ([^\r\n]+)\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)) {
    result[match[1].trim()] = match[2].trim();
  }
  return result;
}

function urls(text) {
  return (text.match(/https?:\/\/[^\s<>]+/gi) || []).map(s => s.replace(/[),.;]+$/, ''));
}

function canonical(raw) {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
    return `${url.hostname.toLowerCase()}${path}`.toLowerCase();
  } catch { return null; }
}

function inspect(body, readme) {
  const data = fields(body);
  for (const key of Object.keys(data)) if (data[key] === '_No response_') delete data[key];
  const evidence = [], changes = [];
  for (const name of REQUIRED) {
    if (!data[name]) evidence.push(`Missing field: ${name}.`);
  }
  const https = value => /^https:\/\/\S+$/.test(value || '');
  const project = data.Link;
  if (data.Link && !https(data.Link)) changes.push('Link must be a single URL starting with https://.');
  if (data['Author Link'] && !https(data['Author Link'])) changes.push('Author Link must be a single URL starting with https://.');
  const length = (data.Description || '').length;
  if (data.Description && (length < 10 || length > 500)) changes.push(`Description must be 10-500 characters (now ${length}).`);
  const existing = new Set(urls(readme).map(canonical));
  if (https(project) && existing.has(canonical(project))) changes.push('The link is already in README.md.');
  const checklist = data.Checklist || '';
  const warnings = [];
  const name = (data['Display Name'] || '').trim().toLowerCase();
  if (name) {
    const listed = [...readme.matchAll(/^\s*- \[([^\]]+)\]\(/gm)].map(m => m[1].trim().toLowerCase());
    if (listed.includes(name)) warnings.push(`An entry named "${data['Display Name']}" already exists in README.md.`);
    if (/^(test|testing|example|foo|bar|asdf|xxx|my (project|resource))$/.test(name)) warnings.push('Display name appears to be a test entry.');
  }
  const trapped = TRAP.test(checklist);
  if ((checklist.match(/^- \[[xX]\]/gm) || []).length - (trapped ? 1 : 0) < CHECKS) changes.push(`Complete all ${CHECKS} checklist items.`);
  let repository = null;
  if (https(project)) {
    const url = new URL(project);
    if (url.hostname.toLowerCase() === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) repository = { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
    }
  }
  return { evidence, changes, warnings, trapped, repository, project: https(project) ? project : null, data };
}

// Facts the bot can read from the repository, so submitters do not have to type them.
function summarize(target, readme) {
  const description = (target.description || '').replace(/\s+/g, ' ').trim();
  return {
    name: target.name,
    description,
    stars: target.stargazers_count,
    archived: target.archived,
    license: target.license?.spdx_id && target.license.spdx_id !== 'NOASSERTION' ? target.license.spdx_id : null,
    created: target.created_at?.slice(0, 10) ?? null,
    pushed: target.pushed_at?.slice(0, 10) ?? null,
    mentionsCodex: /codex/i.test(`${target.description || ''} ${(target.topics || []).join(' ')} ${readme}`),
  };
}

function entry(data) {
  const text = data.Description.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  return `- [${data['Display Name']}](${data.Link}) - ${text}.`;
}

// Threshold matches contributing.md. Below it the submission is labelled for manual review; gate() decides auto-close.
function criteria({ stars }) {
  if (stars >= MIN_STARS) return { met: true, reason: `${stars} stars >= ${MIN_STARS}` };
  return { met: false, reason: `${stars} stars < ${MIN_STARS}` };
}

// Same eligibility rule as contributing.md: 100+ stars, or 14+ days since the first commit.
function gate({ stars, firstCommit, now = Date.now() }) {
  if (stars >= MIN_STARS) return { ok: true, reason: `${stars} stars >= ${MIN_STARS}` };
  const days = (now - new Date(firstCommit).getTime()) / 86400000;
  if (!Number.isFinite(days)) return { ok: true, reason: 'first commit date unreadable' };
  if (days >= MIN_AGE_DAYS) return { ok: true, reason: `${days.toFixed(1)} days >= ${MIN_AGE_DAYS}` };
  return { ok: false, reason: `${days.toFixed(1)} days < ${MIN_AGE_DAYS} and ${stars} stars < ${MIN_STARS}` };
}

// The oldest commit on the default branch; repository creation dates are wrong for repos with pushed history.
async function firstCommitDate(github, repository, branch) {
  const query = { ...repository, sha: branch, per_page: 1 };
  const first = await github.rest.repos.listCommits(query);
  if (!first.data.length) return null;
  const last = (first.headers?.link || '').match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (!last) return first.data[0].commit.committer.date;
  const oldest = await github.rest.repos.listCommits({ ...query, page: Number(last[1]) });
  return oldest.data[0].commit.committer.date;
}

async function autoClose({ github, repo, issue_number, reason }) {
  await github.rest.issues.createComment({ ...repo, issue_number, body:
    `${MARKER}\n## 🤖 Validation Results\n\n⛔ **This resource does not currently meet the submission conditions** (${reason}).\n\n` +
    'A resource needs 100+ GitHub stars, or at least 14 days of development since its first commit. ' +
    'Read contributing.md and submit again when it qualifies.' });
  await github.rest.issues.addLabels({ ...repo, issue_number, labels: ['auto-closed'] });
  await github.rest.issues.update({ ...repo, issue_number, state: 'closed', state_reason: 'not_planned' });
}

async function run({ github, context }) {
  const repo = context.repo;
  for (const [name, [color, description]] of Object.entries(LABELS)) {
    try { await github.rest.issues.getLabel({ ...repo, name }); }
    catch (error) {
      if (error.status !== 404) throw error;
      try { await github.rest.issues.createLabel({ ...repo, name, color, description }); }
      catch (createError) { if (createError.status !== 422) throw createError; }
    }
  }
  if (!context.payload.issue) return; // Manual run bootstraps labels before submissions.
  const issue_number = context.payload.issue.number;
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number });
  if (issue.pull_request || issue.state !== 'open') return;
  const names = issue.labels.map(label => typeof label === 'string' ? label : label.name);
  const resource = names.includes('resource-submission') || issue.title.startsWith('[Resource]');
  if (!resource) {
    if (issue.title.startsWith('[Correction]')) {
      await github.rest.issues.addLabels({ ...repo, issue_number, labels: ['correction'] });
    }
    return;
  }
  const result = inspect(issue.body || '', fs.readFileSync('README.md', 'utf8'));
  const opened = context.payload.action === 'opened';
  if (opened) {
    try {
      const others = await github.paginate(github.rest.issues.listForRepo, {
        ...repo, state: 'open', labels: 'resource-submission', creator: issue.user.login, per_page: 100 });
      const open = others.filter(other => other.number !== issue_number && !other.pull_request);
      if (open.length) {
        return await autoClose({ github, repo, issue_number, reason: `you already have open submission(s): #${open.map(other => other.number).join(', #')}` });
      }
    } catch { /* A failed lookup never closes a submission. */ }
  }
  const notes = [...result.warnings];
  let manual = false;
  if (result.trapped) { manual = true; notes.push('The "do not check" box was checked: the submitter may not have read the checklist.'); }
  let stars = null, archived = null, meets = null, info = null;
  if (result.repository) {
    try {
      const { data: target } = await github.rest.repos.get(result.repository);
      if (opened && target.stargazers_count < MIN_STARS) {
        let first = null;
        try { first = await firstCommitDate(github, result.repository, target.default_branch); } catch { /* Unreadable history passes through. */ }
        const verdict = first ? gate({ stars: target.stargazers_count, firstCommit: first }) : { ok: true };
        if (!verdict.ok) return await autoClose({ github, repo, issue_number, reason: verdict.reason });
      }
      let readme = '';
      try {
        const { data } = await github.rest.repos.getReadme({ ...result.repository, mediaType: { format: 'raw' } });
        readme = typeof data === 'string' ? data : '';
      } catch (error) { if (error.status !== 404) throw error; }
      info = summarize(target, readme);
      stars = info.stars;
      archived = info.archived;
      if (info.archived) { manual = true; notes.push('Archived project: maintainer review required.'); }
      if (!info.mentionsCodex) notes.push('The README and repository description do not mention Codex: check the Codex support by hand.');
      const verdict = criteria({ stars });
      meets = verdict.met;
      if (!verdict.met) {
        manual = true;
        notes.push(`Below inclusion threshold: ${verdict.reason}. Maintainer decides.`);
      }
    } catch {
      manual = true;
      notes.push('GitHub metadata could not be retrieved; a maintainer must check it. This is not a rejection.');
    }
  } else if (result.project) {
    manual = true;
    notes.push('Not a GitHub repository: a maintainer must check the facts by hand.');
  }
  const labels = ['resource-submission'];
  if (result.evidence.length) labels.push('needs-evidence');
  if (result.changes.length) labels.push('needs-changes');
  if (manual) labels.push('manual-review');
  if (!result.evidence.length && !result.changes.length && !manual) labels.push('validation-passed');
  // Remove only our obsolete status labels; preserve unrelated maintainer labels.
  for (const name of STATUS.filter(name => names.includes(name) && !labels.includes(name))) {
    try { await github.rest.issues.removeLabel({ ...repo, issue_number, name }); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  await github.rest.issues.addLabels({ ...repo, issue_number, labels });
  const errors = [...result.evidence, ...result.changes];
  const valid = errors.length === 0;
  const statusLabels = labels.filter(name => name !== 'resource-submission');
  // Same shape as awesome-claude-code's parser output, plus the GitHub facts the bot looked up.
  const [category, subcategory = ''] = (result.data.Category || '').split(' > ');
  const parsed = {
    display_name: result.data['Display Name'] || '', category: category || '', subcategory,
    link: result.data.Link || '', author_name: result.data['Author Name'] || '',
    author_link: result.data['Author Link'] || '', description: result.data.Description || '',
  };
  const output = { valid, errors, warnings: notes, data: parsed, github: info ? { ...info, meetsCriteria: meets } : null };
  const body = `${MARKER}\n## 🤖 Validation Results\n\n` +
    (valid
      ? '✅ **All validation checks passed!** Your recommendation is ready for a maintainer to review.\n\n' +
        '### Parsed data\n```json\n' + JSON.stringify(output.data, null, 2) + '\n```\n\n' +
        '### Entry line\n```md\n' + entry(result.data) + '\n```\n'
      : '❌ **Validation failed.** Please fix the following and edit your issue:\n\n' + errors.map(s => `- ❗ ${s}`).join('\n') + '\n') +
    (notes.length ? '\n### Warnings\n' + notes.map(s => `- ⚠️ ${s}`).join('\n') + '\n' : '') +
    (info ? '\n### GitHub\n| Item | Value |\n|---|---|\n' +
      `| Stars | ${stars} |\n| License | ${info.license ?? 'none'} |\n` +
      `| Created / last push | ${info.created} / ${info.pushed} |\n` +
      `| Mentions Codex | ${info.mentionsCodex ? 'yes' : 'no'} |\n` +
      `| Archived | ${archived ? 'yes' : 'no'} |\n| Meets criteria | ${meets ? 'yes' : 'no'} |\n` : '') +
    `\n**Status:** ${statusLabels.map(name => `\`${name}\``).join(' ')}\n\n` +
    '<details><summary>Raw result (JSON)</summary>\n\n```json\n' + JSON.stringify(output, null, 2) + '\n```\n\n</details>\n\n' +
    'Basic checks only, not verification of quality or approval. Maintainers apply the criteria in contributing.md. Edit this issue to rerun checks.';
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number, per_page: 100 });
  const previous = comments.find(c => c.user.login === 'github-actions[bot]' && c.body?.includes(MARKER));
  if (previous) await github.rest.issues.updateComment({ ...repo, comment_id: previous.id, body });
  else await github.rest.issues.createComment({ ...repo, issue_number, body });
}

module.exports = { fields, canonical, inspect, summarize, entry, criteria, gate, run };
