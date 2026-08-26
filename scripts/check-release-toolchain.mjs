#!/usr/bin/env node
/**
 * Assert that `.github/workflows/release.yml` and the Changesets CLI in the root
 * `package.json` agree with each other.
 *
 * Why this exists: the release workflow only has a `push: main` trigger, so no
 * pull request can ever run it. #156 was a Dependabot bump of `changesets/action`
 * from v1 to v2, batched into the routine weekly `actions` group. It showed green
 * — every check that exists ran and passed, because none of them touch this file
 * — and broke the release on main, where the failure is both invisible until a
 * changeset is waiting and blocking once it is. #167 reverted it.
 *
 * The two halves of that breakage are both checked here:
 *
 *   1. Major coupling. changesets/action v2 dropped Changesets v2 support and
 *      hard-errors when it finds a v2 CLI (changesets/action#699); v1 predates
 *      the v3 CLI. The action's major and the CLI's major move together, and
 *      neither one alone is a valid change.
 *   2. Input names. v2 renamed every input this workflow passes. An unknown
 *      `with:` key is not an error to GitHub Actions — it is silently dropped,
 *      so a mis-migrated step runs with defaults rather than failing, and would
 *      open a version PR titled "Version Packages" running `changeset version`
 *      instead of `pnpm version-packages`.
 *
 * This is deliberately a table rather than a fetch of the action's own
 * `action.yml`: the check should fail on our mistakes, not on upstream retagging
 * a moving major or on the network. Adding a row is part of taking a new major.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = '.github/workflows/release.yml';

/**
 * Inputs accepted by each supported major of changesets/action, and the CLI
 * major it requires. Sourced from the action's `action.yml` at that tag.
 */
const ACTION_MAJORS = {
  1: {
    cliMajor: 2,
    inputs: new Set([
      'publish',
      'version',
      'commit',
      'title',
      'setupGitUser',
      'createGithubReleases',
      'cwd',
      'branch',
      'commitMode',
    ]),
  },
  2: {
    cliMajor: 3,
    inputs: new Set([
      'github-token',
      'publish-script',
      'version-script',
      'commit-message',
      'pr-title',
      'pr-draft',
      'pr-base-branch',
      'create-github-releases',
      'push-git-tags',
      'push-with-git-cli',
      'cwd',
    ]),
  },
};

const problems = [];

const workflow = readFileSync(join(repoRoot, workflowPath), 'utf8');
const lines = workflow.split('\n');

const usesIndex = lines.findIndex((line) => /^\s*uses:\s*changesets\/action@/.test(line));
if (usesIndex === -1) {
  console.error(`${workflowPath}: no \`uses: changesets/action@...\` step found.`);
  console.error('If the release workflow no longer uses it, delete this check with it.');
  process.exit(1);
}

const usesLine = lines[usesIndex];
const ref = usesLine.match(/changesets\/action@(\S+)/)[1];
const actionMajor = ref.match(/^v(\d+)/)?.[1];
if (!actionMajor || !(actionMajor in ACTION_MAJORS)) {
  const known = Object.keys(ACTION_MAJORS)
    .map((major) => `v${major}`)
    .join(', ');
  problems.push(
    `${workflowPath}:${usesIndex + 1}: changesets/action@${ref} is not a major this check knows about.\n` +
      `  Known majors: ${known}.\n` +
      '  Taking a new major means adding its inputs and required CLI major to ACTION_MAJORS\n' +
      '  in scripts/check-release-toolchain.mjs, and migrating the step to match.'
  );
}

const expected = ACTION_MAJORS[actionMajor];

// Read the `with:` and `env:` blocks belonging to this step: everything indented
// deeper than the `uses:` line, up to the next line at that indent or shallower.
const stepIndent = usesLine.match(/^\s*/)[0].length;
const stepBody = [];
for (let i = usesIndex + 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (line.trim() === '' || line.trim().startsWith('#')) continue;
  if (line.match(/^\s*/)[0].length < stepIndent) break;
  if (line.match(/^\s*/)[0].length === stepIndent && !line.trim().startsWith('-')) {
    stepBody.push({ line, index: i, top: true });
    continue;
  }
  if (line.trim().startsWith('- ')) break;
  stepBody.push({ line, index: i, top: false });
}

const withStart = stepBody.find(({ line, top }) => top && line.trim() === 'with:');
if (expected && withStart) {
  const withIndent = withStart.line.match(/^\s*/)[0].length;
  for (const { line, index } of stepBody) {
    if (index <= withStart.index) continue;
    const indent = line.match(/^\s*/)[0].length;
    // Stop at the next key of the step itself (`env:`, `if:`, ...).
    if (indent <= withIndent) break;
    // Only report keys that sit directly under `with:`, not nested values.
    if (indent !== withIndent + 2) continue;
    const key = line.trim().match(/^([\w-]+):/)?.[1];
    if (!key || expected.inputs.has(key)) continue;
    problems.push(
      `${workflowPath}:${index + 1}: \`${key}\` is not an input of changesets/action@v${actionMajor}.\n` +
        '  Unknown inputs are silently ignored by GitHub Actions, so this would not fail at run time.'
    );
  }
}

const envStart = stepBody.find(({ line, top }) => top && line.trim() === 'env:');
if (actionMajor === '2' && envStart) {
  const envIndent = envStart.line.match(/^\s*/)[0].length;
  for (const { line, index } of stepBody) {
    const indent = line.match(/^\s*/)[0].length;
    if (indent !== envIndent + 2) continue;
    if (!/^GITHUB_TOKEN:/.test(line.trim())) continue;
    problems.push(
      `${workflowPath}:${index + 1}: changesets/action@v2 ignores the GITHUB_TOKEN environment variable.\n` +
        '  Pass a custom token through the `github-token` input instead, which already defaults to the\n' +
        '  workflow token.'
    );
  }
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const cliRange = pkg.devDependencies?.['@changesets/cli'];
if (!cliRange) {
  problems.push('package.json: `@changesets/cli` is not a root devDependency.');
} else if (expected) {
  const cliMajor = cliRange.match(/(\d+)\./)?.[1];
  if (cliMajor !== String(expected.cliMajor)) {
    problems.push(
      `changesets/action@v${actionMajor} requires Changesets CLI v${expected.cliMajor}, ` +
        `but package.json pins \`@changesets/cli\`: "${cliRange}".\n` +
        '  These two majors move together. Bump both in one change, or neither.'
    );
  }
}

if (problems.length > 0) {
  console.error('Release toolchain check failed:\n');
  for (const problem of problems) {
    console.error(`  ${problem}\n`);
  }
  process.exit(1);
}

console.log(`Release toolchain OK: changesets/action@${ref} with @changesets/cli ${cliRange}.`);
