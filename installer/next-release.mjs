#!/usr/bin/env node
// Decides the next release from the commits since the last tag and writes it (Node built-ins only).
//
//   node installer/next-release.mjs --root <repo> --last <X.Y.Z> --commits <file> --date <YYYY-MM-DD> --notes <file> [--dry-run]
//
// The release workflow runs it after a green CI on main. <commits> holds `git log` output,
// one commit per record: the full message, records separated by a NUL byte. Each subject is a
// Conventional Commit (`type(scope)!: text`):
//
//   * a `!` after the type, or a `BREAKING CHANGE:` footer, bumps the major;
//   * `feat` bumps the minor;
//   * `fix`, `perf`, `refactor`, `chore`, `build`, `revert` and any subject without a known
//     type bump the patch;
//   * `docs`, `test`, `ci` and `style` alone release nothing, nor does the bot's own
//     `chore: release X.Y.Z` commit.
//
// When there is something to release it sets server/package.json's version (the one place a
// version is written), turns CHANGELOG.md's `## [Unreleased]` section into
// `## [X.Y.Z] - <date>` (or, with no such section, writes one from the commit subjects),
// writes that section's text to <notes> and prints `version=X.Y.Z`. Otherwise it prints
// `release=false` and writes nothing. --dry-run prints the decision only.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SUBJECT = /^([a-z]+)(\([^)]*\))?(!)?: (.+)$/;
const QUIET_TYPES = new Set(['docs', 'test', 'ci', 'style']);
const RELEASE_COMMIT = /^chore: release \d+\.\d+\.\d+$/;
const LEVELS = ['none', 'patch', 'minor', 'major'];

/** The bump one commit message asks for: 'none', 'patch', 'minor' or 'major'. */
export function bumpOf(message) {
  const subject = message.split('\n')[0].trim();
  if (subject === '' || RELEASE_COMMIT.test(subject)) return 'none';
  if (/^BREAKING[ -]CHANGE: /m.test(message)) return 'major';
  const m = SUBJECT.exec(subject);
  if (!m) return 'patch';
  const [, type, , bang] = m;
  if (bang) return 'major';
  if (type === 'feat') return 'minor';
  // fix, perf, refactor, chore, build, revert and unknown types are a patch.
  return QUIET_TYPES.has(type) ? 'none' : 'patch';
}

/** The largest bump among the messages. */
export function bumpOfAll(messages) {
  return messages.map(bumpOf).reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), 'none');
}

/** `last` raised by `bump`. */
export function nextVersion(last, bump) {
  const m = SEMVER.exec(last);
  if (!m) throw new Error(`not an X.Y.Z version: ${last}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`nothing to bump: ${bump}`);
}

/** A changelog section body from the commit subjects, grouped as Keep a Changelog does. */
export function sectionFromCommits(messages) {
  const groups = { Added: [], Fixed: [], Changed: [] };
  for (const message of messages) {
    if (bumpOf(message) === 'none') continue;
    const subject = message.split('\n')[0].trim();
    const m = SUBJECT.exec(subject);
    const text = m ? m[4] : subject;
    const line = '- ' + text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
    if (m && m[1] === 'feat') groups.Added.push(line);
    else if (m && m[1] === 'fix') groups.Fixed.push(line);
    else groups.Changed.push(line);
  }
  return Object.entries(groups)
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => `### ${title}\n${lines.join('\n')}`)
    .join('\n\n');
}

/**
 * CHANGELOG.md with the new version's section, and that section's body. The `## [Unreleased]`
 * section is renamed when it holds text; else a section is written from the commits, placed
 * before the first version section.
 */
export function updateChangelog(text, version, date, messages) {
  const lines = text.split('\n');
  const heading = `## [${version}] - ${date}`;
  const at = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (at >= 0) {
    const end = lines.findIndex((l, i) => i > at && l.startsWith('## ['));
    const body = lines.slice(at + 1, end < 0 ? lines.length : end).join('\n').trim();
    if (body !== '') {
      lines.splice(at, 1, heading);
      return { text: lines.join('\n'), notes: body + '\n' };
    }
    lines.splice(at, (end < 0 ? lines.length : end) - at);
  }
  const body = sectionFromCommits(messages);
  const first = lines.findIndex((l) => l.startsWith('## ['));
  const insert = [heading, '', body, ''];
  if (first < 0) lines.push('', ...insert);
  else lines.splice(first, 0, ...insert);
  return { text: lines.join('\n'), notes: body + '\n' };
}

function main(argv) {
  const opt = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opt.dryRun = true;
    else if (['--root', '--last', '--commits', '--date', '--notes'].includes(a) && argv[i + 1] !== undefined) opt[a.slice(2)] = argv[++i];
    else throw new Error(`bad argument: ${a}`);
  }
  for (const k of ['root', 'last', 'commits', 'date', 'notes']) if (!opt[k]) throw new Error(`--${k} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opt.date)) throw new Error(`--date must be YYYY-MM-DD: ${opt.date}`);

  const messages = fs.readFileSync(opt.commits, 'utf8').split('\0').map((m) => m.trim()).filter(Boolean);
  const bump = bumpOfAll(messages);
  if (bump === 'none') {
    process.stdout.write('release=false\n');
    return;
  }
  const version = nextVersion(opt.last, bump);
  process.stdout.write(`release=true\nbump=${bump}\nversion=${version}\n`);
  if (opt.dryRun) return;

  const pkgPath = path.join(opt.root, 'server', 'package.json');
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText);
  pkg.version = version;
  const indent = /^(\s+)"/m.exec(pkgText)?.[1] ?? '  ';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + '\n');

  const logPath = path.join(opt.root, 'CHANGELOG.md');
  const log = updateChangelog(fs.readFileSync(logPath, 'utf8'), version, opt.date, messages);
  fs.writeFileSync(logPath, log.text);
  fs.writeFileSync(opt.notes, log.notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`next-release: ${e.message}\n`);
    process.exit(2);
  }
}
