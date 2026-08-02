#!/usr/bin/env bun

'use strict';

const fs = require('fs');
const path = require('path');

const {
  createRepairTask,
  evaluateMergeCandidates,
  getBlockedTasks,
  getReadyTasks,
  getScopeConflicts,
  parseWorkQueue,
  serializeWorkQueue,
  updateWorkQueue,
} = require('../core/fleet/session');
const { authorizeDecision } = require('../core/governance');
const { listReadinessReports, matchReadiness } = require('../core/worktree/readiness');

function parseArgs(argv) {
  const args = {
    projectRoot: process.cwd(),
    recent: 10,
    json: false,
    write: false,
    overrideReadiness: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--project-root') { args.projectRoot = path.resolve(value); i++; }
    else if (key === '--session') { args.session = value; i++; }
    else if (key === '--recent') { args.recent = Number.parseInt(value, 10); i++; }
    else if (key === '--mark-failed') { args.markFailed = String(value || '').replace(/^#/, ''); i++; }
    else if (key === '--reason') { args.reason = value || ''; i++; }
    else if (key === '--json') args.json = true;
    else if (key === '--write') args.write = true;
    else if (key === '--override-readiness') args.overrideReadiness = true;
    else if (key === '--help' || key === '-h') args.help = true;
  }

  return args;
}

function usage() {
  return [
    'Usage: bun scripts/fleet-steward.js [--session path] [--json]',
    '       bun scripts/fleet-steward.js --session path --mark-failed 2 --reason "why" --write',
    '',
    'Reads a Fleet session markdown work queue and reports runnable tasks,',
    'blocked tasks, readiness blockers, merge candidates, and same-wave scope conflicts.',
    '',
    'Writes only when --write is paired with --mark-failed.',
  ].join('\n');
}

function latestSession(projectRoot) {
  const dir = path.join(projectRoot, '.planning', 'fleet');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((file) => /^session-.*\.md$/i.test(file))
    .map((file) => {
      const fullPath = path.join(dir, file);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files.length ? files[0].fullPath : null;
}

function resolveSessionPath(args) {
  if (args.session) {
    return path.resolve(args.projectRoot, args.session);
  }
  return latestSession(args.projectRoot);
}

function taskLabel(task) {
  return `#${task.id} ${task.campaign || '(unnamed)'} [${task.status}]`;
}

function renderList(title, rows, emptyText) {
  const output = [title];
  if (!rows.length) {
    output.push(`  ${emptyText}`);
    return output.join('\n');
  }
  for (const row of rows) output.push(`  - ${row}`);
  return output.join('\n');
}

function analyzeTasks(tasks, options = {}) {
  const readinessReports = options.readinessReports || [];
  const readyWithReadiness = [];
  const readinessBlocked = [];
  for (const task of getReadyTasks(tasks)) {
    const readiness = matchReadiness(task, readinessReports);
    if (readiness && readiness.blockFleet && !options.overrideReadiness) {
      readinessBlocked.push({ task, readiness });
    } else {
      readyWithReadiness.push({ ...task, readiness });
    }
  }

  const blocked = getBlockedTasks(tasks);
  const authorize = options.authorize || (options.projectRoot
    ? (_task, authority, disposition) => authorizeDecision(
      options.projectRoot,
      authority,
      disposition,
    )
    : null);
  const mergeAssessments = evaluateMergeCandidates(tasks, {
    authorize,
    sessionId: options.sessionId,
  });
  const mergeBlocked = mergeAssessments.filter((entry) => !entry.merge.ok);
  const governanceBlocked = mergeAssessments
    .filter((entry) => entry.merge.ok && entry.governance?.authorized !== true);

  return {
    count: tasks.length,
    ready: readyWithReadiness,
    blocked,
    readinessBlocked,
    mergeCandidates: mergeAssessments
      .filter((entry) => entry.merge.ok && entry.governance?.authorized === true)
      .map((entry) => entry.task),
    mergeBlocked,
    governanceBlocked,
    scopeConflicts: getScopeConflicts(tasks),
  };
}

function renderReport(snapshot) {
  const lines = [];
  lines.push('Fleet Steward');
  lines.push('='.repeat(40));
  lines.push(`Session: ${snapshot.sessionPath || '(none found)'}`);
  lines.push(`Tasks:   ${snapshot.analysis.count}`);
  lines.push('');

  lines.push(renderList(
    'READY TO RUN',
    snapshot.analysis.ready.map((task) => `${taskLabel(task)} - wave ${task.wave || '-'} - scope ${task.scope.join(', ') || 'none'}`),
    'No runnable pending tasks.'
  ));
  lines.push('');

  lines.push(renderList(
    'READINESS BLOCKED',
    snapshot.analysis.readinessBlocked.map((entry) => {
      const reason = (entry.readiness.checks || [])
        .filter((check) => check.status === 'fail')
        .map((check) => check.detail)
        .join('; ');
      return `${taskLabel(entry.task)} blocked by ${entry.readiness.status} worktree readiness${reason ? ` - ${reason}` : ''}`;
    }),
    'No readiness-blocked ready tasks.'
  ));
  lines.push('');

  lines.push(renderList(
    'BLOCKED',
    snapshot.analysis.blocked.map((entry) => {
      const blockers = entry.blockers.map((blocker) => `#${blocker.dep} ${blocker.status}`).join(', ');
      return `${taskLabel(entry.task)} waits for ${blockers}`;
    }),
    'No dependency-blocked tasks.'
  ));
  lines.push('');

  lines.push(renderList(
    'MERGE NEXT',
    snapshot.analysis.mergeCandidates.map((task) => `${taskLabel(task)} - branch ${task.branch || '-'}`),
    'No merge-ready tasks with satisfied merge order.'
  ));
  lines.push('');

  lines.push(renderList(
    'MERGE BLOCKED',
    snapshot.analysis.mergeBlocked.map((entry) => {
      const blockers = entry.merge.blockers.map((blocker) => `#${blocker.dep} ${blocker.status}`).join(', ');
      return `${taskLabel(entry.task)} waits for merged dependencies: ${blockers}`;
    }),
    'No merge-order blockers.'
  ));
  lines.push('');

  lines.push(renderList(
    'GOVERNANCE BLOCKED',
    snapshot.analysis.governanceBlocked.map((entry) => {
      const code = entry.governance?.authorization_code || 'GOVERNANCE_AUTHORITY_INVALID';
      return `${taskLabel(entry.task)} - ${code} - subject ${entry.authority.id}`;
    }),
    'No governance-blocked merge candidates.'
  ));
  lines.push('');

  lines.push(renderList(
    'SCOPE CONFLICTS',
    snapshot.analysis.scopeConflicts.map((conflict) => {
      return `Wave ${conflict.wave}: #${conflict.left.id} overlaps #${conflict.right.id}`;
    }),
    'No same-wave write-scope conflicts.'
  ));

  if (snapshot.repair) {
    lines.push('');
    lines.push('REPAIR TASK');
    lines.push(`  ${snapshot.wrote ? 'Wrote' : 'Preview'} #${snapshot.repair.id}: ${snapshot.repair.campaign}`);
  }

  lines.push('');
  lines.push('QUICK COMMANDS');
  lines.push('  bun scripts/fleet-steward.js --session <file> --json');
  lines.push('  bun scripts/fleet-steward.js --session <file> --mark-failed <id> --reason "<why>" --write');

  return lines.join('\n');
}

function collect(args) {
  const sessionPath = resolveSessionPath(args);
  const sessionId = sessionPath
    ? path.basename(sessionPath, path.extname(sessionPath))
    : 'fleet-session';
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return {
      sessionPath,
      tasks: [],
      analysis: analyzeTasks([], { projectRoot: args.projectRoot, sessionId }),
      readinessReports: [],
      repair: null,
      wrote: false,
      error: 'No fleet session file found.',
    };
  }

  const original = fs.readFileSync(sessionPath, 'utf8');
  const tasks = parseWorkQueue(original);
  const readinessReports = listReadinessReports(args.projectRoot);
  let repair = null;
  let wrote = false;

  if (args.markFailed) {
    const failed = tasks.find((task) => task.id === args.markFailed);
    if (!failed) {
      return {
        sessionPath,
        tasks,
        analysis: analyzeTasks(tasks, {
          readinessReports,
          overrideReadiness: args.overrideReadiness,
          projectRoot: args.projectRoot,
          sessionId,
        }),
        readinessReports,
        repair,
        wrote,
        error: `Task #${args.markFailed} was not found.`,
      };
    }

    failed.status = 'failed';
    failed.evidence = args.reason ? `${failed.evidence && failed.evidence !== '-' ? `${failed.evidence}; ` : ''}${args.reason}` : failed.evidence;
    repair = createRepairTask(tasks, failed, args.reason || '');
    tasks.push(repair);

    if (args.write) {
      fs.writeFileSync(sessionPath, updateWorkQueue(original, tasks));
      wrote = true;
    }
  }

  return {
    sessionPath,
    tasks,
    analysis: analyzeTasks(tasks, {
      readinessReports,
      overrideReadiness: args.overrideReadiness,
      projectRoot: args.projectRoot,
      sessionId,
    }),
    readinessReports,
    repair,
    wrote,
    table: serializeWorkQueue(tasks),
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const snapshot = collect(args);
  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(renderReport(snapshot));
    if (snapshot.error && args.session) process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeTasks,
  collect,
  parseArgs,
  renderReport,
  usage,
};
