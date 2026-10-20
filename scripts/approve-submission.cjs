const fs = require('node:fs');
const { fields, entry } = require('./validate-submission.cjs');

// "Agent Skills > General" resolves to the "General" heading under "Agent Skills".
function headingText(line) {
  return line.replace(/^#+\s*/, '').replace(/[^\p{L}\p{N}&>\s-]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findSection(readme, category) {
  const parts = category.split(' > ').map(part => part.trim().toLowerCase());
  const lines = readme.split('\n');
  let from = 0;
  let found = -1;
  for (const part of parts) {
    found = -1;
    for (let i = from; i < lines.length; i++) {
      if (/^#{2,6}\s/.test(lines[i]) && headingText(lines[i]) === part) { found = i; break; }
    }
    if (found < 0) return null;
    from = found + 1;
  }
  let end = lines.length;
  for (let i = found + 1; i < lines.length; i++) {
    if (/^#{2,6}\s/.test(lines[i])) { end = i; break; }
  }
  return { start: found, end, lines };
}

// Appends the entry after the last list item of the section. Returns the new README text.
function insertEntry(readme, category, line) {
  const section = findSection(readme, category);
  if (!section) throw new Error(`No README section matches "${category}".`);
  let last = -1;
  for (let i = section.start + 1; i < section.end; i++) if (/^- \[/.test(section.lines[i])) last = i;
  if (last < 0) throw new Error(`Section "${category}" has no list to append to.`);
  section.lines.splice(last + 1, 0, line);
  return section.lines.join('\n');
}

function parseCommand(comment) {
  const match = comment.match(/^\/(approve|reject|request-changes)\b[ \t]*(.*)$/m);
  return match ? { command: match[1], reason: match[2].trim() } : null;
}

// Runs inside actions/github-script after checkout. Returns { branch, title } for the PR step on approval.
async function run({ github, context, core }) {
  const repo = context.repo;
  const issue_number = context.payload.issue.number;
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number });
  const names = issue.labels.map(label => label.name);
  const parsed = parseCommand(context.payload.comment.body);
  const say = body => github.rest.issues.createComment({ ...repo, issue_number, body });
  if (!parsed || !names.includes('resource-submission')) return;
  if (parsed.command === 'reject') {
    await say(`## ❌ Submission Rejected\n\n**Reason:** ${parsed.reason || 'Does not meet the inclusion criteria in contributing.md.'}`);
    await github.rest.issues.update({ ...repo, issue_number, state: 'closed', state_reason: 'not_planned' });
    return;
  }
  if (parsed.command === 'request-changes') {
    await say(`## 🔧 Changes requested\n\n${parsed.reason || 'A maintainer asked for changes.'}\n\nEdit your issue to rerun the checks.`);
    return;
  }
  if (!names.includes('validation-passed')) {
    await say('Cannot approve: the issue does not have the `validation-passed` label. Fix the reported problems and edit the issue first.');
    return;
  }
  const data = fields(issue.body || '');
  const readme = fs.readFileSync('README.md', 'utf8');
  fs.writeFileSync('README.md', insertEntry(readme, data.Category, entry(data)));
  core.setOutput('approved', 'true');
  core.setOutput('branch', `resource/issue-${issue_number}`);
  core.setOutput('title', `Add ${data['Display Name']}`);
  core.setOutput('issue', String(issue_number));
}

module.exports = { findSection, insertEntry, parseCommand, run };
