'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 1;
const MIN_SQLITE_NODE_MAJOR = 22;
const MIN_SQLITE_NODE_MINOR = 13;
const MIN_SQLITE_NODE_VERSION = `${MIN_SQLITE_NODE_MAJOR}.${MIN_SQLITE_NODE_MINOR}`;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_SYNC_BYTES = 50 * 1024 * 1024;
const DURABLE_DIRECTORIES = Object.freeze([
  '.planning/campaigns/completed',
  '.planning/postmortems',
  '.planning/research',
  '.planning/discoveries',
  '.planning/intake',
]);
const DURABLE_FILES = Object.freeze(['.citadel/project.md']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeRemoteUrl(input) {
  let value = String(input || '').trim();
  if (!value) return null;

  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (!value.includes('://') && scp && !/^[a-zA-Z]:[\\/]/.test(value)) {
    value = `ssh://${scp[1]}/${scp[2]}`;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const defaultPorts = { 'git:': '9418', 'http:': '80', 'https:': '443', 'ssh:': '22' };
    const authority = parsed.port && parsed.port !== defaultPorts[parsed.protocol]
      ? `${host}:${parsed.port}`
      : host;
    let pathname = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, '');
    pathname = pathname.replace(/\.git$/i, '');
    if (!host || !pathname) return null;
    return `${authority}/${pathname}`;
  } catch {
    // Relative paths and local filesystem remotes are not stable cross-clone
    // identities. Fall back to the clone's canonical local path instead.
    return null;
  }
}

function runGit(projectRoot, args, options = {}) {
  const spawn = options.spawn || spawnSync;
  const result = spawn('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function realpathOrResolved(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function repositoryIdentity(projectRoot, options = {}) {
  const requestedRoot = path.resolve(projectRoot);
  const gitRoot = runGit(requestedRoot, ['rev-parse', '--show-toplevel'], options);
  const root = realpathOrResolved(gitRoot || requestedRoot);
  const remote = runGit(root, ['remote', 'get-url', 'origin'], options);
  const normalizedRemote = normalizeRemoteUrl(remote);
  if (normalizedRemote) {
    return {
      repository_id: sha256(`remote:v1:${normalizedRemote}`),
      identity_kind: 'remote',
      portable: true,
      project_root: root,
    };
  }

  let canonical = root;
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return {
    repository_id: sha256(`local:v1:${normalizeSlashes(canonical)}`),
    identity_kind: 'local-path',
    portable: false,
    project_root: root,
  };
}

function defaultDatabasePath(options = {}) {
  const env = options.env || process.env;
  if (env.CITADEL_MEMORY_DB) return path.resolve(env.CITADEL_MEMORY_DB);
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, 'Citadel', 'repository-memory.sqlite3');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Citadel', 'repository-memory.sqlite3');
  }
  const state = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(state, 'citadel', 'repository-memory.sqlite3');
}

function loadBuiltinSqlite() {
  const original = process.emitWarning;
  try {
    // Node 22 emits this warning on every short-lived hook process. The feature
    // is explicitly opt-in, so suppress only the module's known warning while
    // preserving every other process warning.
    process.emitWarning = function filteredWarning(warning, ...args) {
      const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
      if (type === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(String(warning))) return;
      return original.call(process, warning, ...args);
    };
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

function loadBunSqlite() {
  // Bun ships an embedded SQLite as `bun:sqlite`. Its `Database` class matches
  // the subset of the node:sqlite `DatabaseSync` API this module uses:
  // prepare()/exec()/close() on the connection and run()/get()/all() with
  // positional binding on statements. BLOBs come back as Uint8Array, which the
  // consumers already wrap via `Buffer.from(...)`.
  const { Database } = require('bun:sqlite');
  return { DatabaseSync: Database };
}

function isBunRuntime(options = {}) {
  if (typeof options.bun === 'boolean') return options.bun;
  return Boolean(process.versions && process.versions.bun);
}

function sqliteCapability(options = {}) {
  if (options.DatabaseSync) return { available: true, DatabaseSync: options.DatabaseSync };
  if (isBunRuntime(options)) {
    try {
      const { DatabaseSync } = loadBunSqlite();
      return { available: true, DatabaseSync };
    } catch (error) {
      return {
        available: false,
        code: 'CITADEL_SQLITE_UNAVAILABLE',
        reason: `The bun:sqlite module is unavailable: ${error.message}`,
      };
    }
  }
  const [major, minor] = String(options.nodeVersion || process.versions.node).split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)
    || major < MIN_SQLITE_NODE_MAJOR
    || (major === MIN_SQLITE_NODE_MAJOR && minor < MIN_SQLITE_NODE_MINOR)) {
    return {
      available: false,
      code: 'CITADEL_SQLITE_UNAVAILABLE',
      reason: `Cross-clone memory requires Node.js ${MIN_SQLITE_NODE_VERSION}+; current runtime is ${options.nodeVersion || process.versions.node}.`,
    };
  }
  try {
    const { DatabaseSync } = loadBuiltinSqlite();
    return { available: true, DatabaseSync };
  } catch (error) {
    return {
      available: false,
      code: 'CITADEL_SQLITE_UNAVAILABLE',
      reason: `The node:sqlite module is unavailable: ${error.message}`,
    };
  }
}

function schemaSql() {
  return `
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS repositories (
      repository_id TEXT PRIMARY KEY,
      identity_kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT,
      last_restored_at TEXT
    );
    CREATE TABLE IF NOT EXISTS entries (
      repository_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      content BLOB NOT NULL,
      content_sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, relative_path),
      FOREIGN KEY (repository_id) REFERENCES repositories(repository_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS entry_versions (
      repository_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      bytes INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, relative_path, content_sha256),
      FOREIGN KEY (repository_id) REFERENCES repositories(repository_id) ON DELETE CASCADE
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `;
}

function openDatabase(options = {}) {
  const capability = sqliteCapability(options);
  if (!capability.available) {
    const error = new Error(capability.reason);
    error.code = capability.code;
    throw error;
  }
  const databasePath = options.databasePath || defaultDatabasePath(options);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(databasePath)) {
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error(`Repository memory database must be a plain file: ${databasePath}`);
      error.code = 'CITADEL_MEMORY_DB_UNSAFE';
      throw error;
    }
  } else {
    // Establish private permissions before SQLite writes schema or content.
    // `wx` also avoids following a destination created during the check.
    try {
      fs.closeSync(fs.openSync(databasePath, 'wx', 0o600));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        const unsafe = new Error(`Repository memory database must be a plain file: ${databasePath}`);
        unsafe.code = 'CITADEL_MEMORY_DB_UNSAFE';
        throw unsafe;
      }
    }
  }
  try { fs.chmodSync(databasePath, 0o600); } catch { /* Windows and some filesystems ignore POSIX modes */ }
  const db = new capability.DatabaseSync(databasePath);
  const observedVersion = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (observedVersion > SCHEMA_VERSION) {
    db.close();
    const error = new Error(`Repository memory schema ${observedVersion} is newer than supported schema ${SCHEMA_VERSION}. Update Citadel before opening it.`);
    error.code = 'CITADEL_MEMORY_SCHEMA_UNSUPPORTED';
    throw error;
  }
  db.exec(schemaSql());
  return { db, databasePath };
}

function normalizedRelative(projectRoot, filePath) {
  const root = realpathOrResolved(projectRoot);
  const requested = path.resolve(filePath);
  const candidate = fs.existsSync(requested) ? realpathOrResolved(requested) : requested;
  const relative = normalizeSlashes(path.relative(root, candidate));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

function pathContainsSymlink(projectRoot, relativePath) {
  let cursor = path.resolve(projectRoot);
  for (const segment of normalizeSlashes(relativePath).split('/')) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) return false;
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function isDurablePath(relativePath) {
  const relative = normalizeSlashes(relativePath).replace(/^\.\//, '');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
  if (DURABLE_FILES.includes(relative)) return true;
  if (!relative.endsWith('.md') || /(?:^|\/)\_TEMPLATE\.md$/i.test(relative)) return false;
  return DURABLE_DIRECTORIES.some((directory) => relative.startsWith(`${directory}/`));
}

function readDurableFile(projectRoot, relativePath) {
  if (!isDurablePath(relativePath)) return { skipped: 'not-durable' };
  const absolute = path.resolve(projectRoot, ...relativePath.split('/'));
  if (normalizedRelative(projectRoot, absolute) !== relativePath) return { skipped: 'unsafe-path' };
  if (pathContainsSymlink(projectRoot, relativePath)) return { skipped: 'symlink-path' };
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return { skipped: 'missing' }; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { skipped: 'not-plain-file' };
  if (stat.size > MAX_ENTRY_BYTES) return { skipped: 'entry-too-large', bytes: stat.size };
  const content = fs.readFileSync(absolute);
  return {
    relative_path: relativePath,
    content,
    content_sha256: sha256(content),
    bytes: content.length,
  };
}

function collectDurableEntries(projectRoot) {
  const root = path.resolve(projectRoot);
  const entries = [];
  const skipped = [];
  let totalBytes = 0;

  const add = (relative) => {
    const item = readDurableFile(root, relative);
    if (item.skipped) {
      if (!['missing', 'not-durable'].includes(item.skipped)) skipped.push({ path: relative, reason: item.skipped });
      return;
    }
    if (totalBytes + item.bytes > MAX_SYNC_BYTES) {
      skipped.push({ path: relative, reason: 'sync-limit-exceeded' });
      return;
    }
    totalBytes += item.bytes;
    entries.push(item);
  };

  for (const relative of DURABLE_FILES) add(relative);
  for (const directory of DURABLE_DIRECTORIES) {
    const absoluteRoot = path.join(root, ...directory.split('/'));
    if (!fs.existsSync(absoluteRoot)) continue;
    if (pathContainsSymlink(root, directory)) {
      skipped.push({ path: directory, reason: 'symlink-path' });
      continue;
    }
    const visit = (absolute) => {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const candidate = path.join(absolute, entry.name);
        if (entry.isSymbolicLink()) {
          const relative = normalizedRelative(root, candidate);
          skipped.push({ path: relative || candidate, reason: 'symlink-path' });
          continue;
        }
        if (entry.isDirectory()) visit(candidate);
        else if (entry.isFile()) {
          const relative = normalizedRelative(root, candidate);
          if (relative && isDurablePath(relative)) add(relative);
        }
      }
    };
    visit(absoluteRoot);
  }
  return { entries: entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path)), skipped, totalBytes };
}

function withTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  }
}

function registerRepository(db, identity, enabled = true, now = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO repositories(repository_id, identity_kind, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET
      identity_kind = excluded.identity_kind,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(identity.repository_id, identity.identity_kind, enabled ? 1 : 0, now, now);
}

function repositoryRow(db, repositoryId) {
  return db.prepare('SELECT * FROM repositories WHERE repository_id = ?').get(repositoryId) || null;
}

function syncEntries(db, identity, items, now) {
  const version = db.prepare(`
    INSERT OR IGNORE INTO entry_versions
      (repository_id, relative_path, content_sha256, content, bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const current = db.prepare(`
    INSERT INTO entries(repository_id, relative_path, content, content_sha256, bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, relative_path) DO UPDATE SET
      content = excluded.content,
      content_sha256 = excluded.content_sha256,
      bytes = excluded.bytes,
      captured_at = excluded.captured_at
  `);
  let versionsAdded = 0;
  for (const item of items) {
    const result = version.run(
      identity.repository_id, item.relative_path, item.content_sha256,
      item.content, item.bytes, now,
    );
    versionsAdded += Number(result.changes || 0);
    current.run(
      identity.repository_id, item.relative_path, item.content,
      item.content_sha256, item.bytes, now,
    );
  }
  db.prepare(`
    UPDATE repositories SET updated_at = ?, last_synced_at = ? WHERE repository_id = ?
  `).run(now, now, identity.repository_id);
  return versionsAdded;
}

function enableRepository(projectRoot, options = {}) {
  const identity = repositoryIdentity(projectRoot, options);
  const collected = collectDurableEntries(identity.project_root);
  const opened = openDatabase(options);
  try {
    const now = new Date().toISOString();
    const versionsAdded = withTransaction(opened.db, () => {
      registerRepository(opened.db, identity, true, now);
      return syncEntries(opened.db, identity, collected.entries, now);
    });
    return {
      status: 'enabled', database_path: opened.databasePath, ...identity,
      entries_synced: collected.entries.length, versions_added: versionsAdded,
      bytes_synced: collected.totalBytes, skipped: collected.skipped,
    };
  } finally {
    opened.db.close();
  }
}

function syncRepository(projectRoot, options = {}) {
  const databasePath = options.databasePath || defaultDatabasePath(options);
  if (!fs.existsSync(databasePath)) return { status: 'not-configured', database_path: databasePath };
  const identity = repositoryIdentity(projectRoot, options);
  const opened = openDatabase({ ...options, databasePath });
  try {
    const row = repositoryRow(opened.db, identity.repository_id);
    if (!row || row.enabled !== 1) return { status: 'disabled', database_path: databasePath, ...identity };
    let collected;
    if (options.filePath) {
      const relative = normalizedRelative(identity.project_root, options.filePath);
      const item = relative ? readDurableFile(identity.project_root, relative) : { skipped: 'unsafe-path' };
      collected = item.skipped
        ? { entries: [], skipped: [{ path: relative || String(options.filePath), reason: item.skipped }], totalBytes: 0 }
        : { entries: [item], skipped: [], totalBytes: item.bytes };
    } else {
      collected = collectDurableEntries(identity.project_root);
    }
    const now = new Date().toISOString();
    const versionsAdded = withTransaction(opened.db, () => syncEntries(opened.db, identity, collected.entries, now));
    return {
      status: 'synced', database_path: databasePath, ...identity,
      entries_synced: collected.entries.length, versions_added: versionsAdded,
      bytes_synced: collected.totalBytes, skipped: collected.skipped,
    };
  } finally {
    opened.db.close();
  }
}

function restoreRepository(projectRoot, options = {}) {
  const databasePath = options.databasePath || defaultDatabasePath(options);
  if (!fs.existsSync(databasePath)) return { status: 'not-configured', database_path: databasePath };
  const identity = repositoryIdentity(projectRoot, options);
  const opened = openDatabase({ ...options, databasePath });
  try {
    const row = repositoryRow(opened.db, identity.repository_id);
    if (!row || row.enabled !== 1) return { status: 'disabled', database_path: databasePath, ...identity };
    const rows = opened.db.prepare(`
      SELECT relative_path, content, content_sha256, bytes, captured_at
      FROM entries WHERE repository_id = ? ORDER BY relative_path
    `).all(identity.repository_id);
    const restored = [];
    const unchanged = [];
    const conflicts = [];
    const skipped = [];
    for (const entry of rows) {
      if (!isDurablePath(entry.relative_path)) {
        skipped.push({ path: entry.relative_path, reason: 'unsafe-or-unsupported-path' });
        continue;
      }
      const destination = path.resolve(identity.project_root, ...entry.relative_path.split('/'));
      if (normalizedRelative(identity.project_root, destination) !== entry.relative_path) {
        skipped.push({ path: entry.relative_path, reason: 'unsafe-path' });
        continue;
      }
      if (pathContainsSymlink(identity.project_root, entry.relative_path)) {
        conflicts.push({ path: entry.relative_path, reason: 'destination-path-contains-symlink' });
        continue;
      }
      const content = Buffer.from(entry.content);
      if (sha256(content) !== entry.content_sha256 || content.length !== entry.bytes) {
        skipped.push({ path: entry.relative_path, reason: 'database-content-digest-mismatch' });
        continue;
      }
      if (fs.existsSync(destination)) {
        const destinationStat = fs.lstatSync(destination);
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
          conflicts.push({ path: entry.relative_path, reason: 'destination-is-not-a-plain-file' });
          continue;
        }
        const existing = fs.readFileSync(destination);
        const existingDigest = sha256(existing);
        if (existingDigest === entry.content_sha256) {
          unchanged.push(entry.relative_path);
          continue;
        }
        if (!options.force) {
          conflicts.push({ path: entry.relative_path, local_sha256: existingDigest, stored_sha256: entry.content_sha256 });
          continue;
        }
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
      restored.push(entry.relative_path);
    }
    const now = new Date().toISOString();
    opened.db.prepare(`
      UPDATE repositories SET updated_at = ?, last_restored_at = ? WHERE repository_id = ?
    `).run(now, now, identity.repository_id);
    return {
      status: conflicts.length ? 'restored-with-conflicts' : 'restored',
      database_path: databasePath, ...identity, restored, unchanged, conflicts, skipped,
    };
  } finally {
    opened.db.close();
  }
}

function listVersions(projectRoot, options = {}) {
  const databasePath = options.databasePath || defaultDatabasePath(options);
  if (!fs.existsSync(databasePath)) return { status: 'not-configured', database_path: databasePath, versions: [] };
  const identity = repositoryIdentity(projectRoot, options);
  const relativePath = options.relativePath
    ? normalizeSlashes(options.relativePath).replace(/^\.\//, '')
    : null;
  if (relativePath && !isDurablePath(relativePath)) {
    const error = new Error(`Version path is not eligible durable memory: ${relativePath}`);
    error.code = 'CITADEL_MEMORY_PATH_UNSUPPORTED';
    throw error;
  }
  const opened = openDatabase({ ...options, databasePath });
  try {
    const row = repositoryRow(opened.db, identity.repository_id);
    if (!row) return { status: 'not-enabled', database_path: databasePath, ...identity, versions: [] };
    const base = `
      SELECT v.relative_path, v.content_sha256, v.bytes, v.captured_at,
        CASE WHEN e.content_sha256 = v.content_sha256 THEN 1 ELSE 0 END AS is_current
      FROM entry_versions v
      LEFT JOIN entries e ON e.repository_id = v.repository_id AND e.relative_path = v.relative_path
      WHERE v.repository_id = ?`;
    const rows = relativePath
      ? opened.db.prepare(`${base} AND v.relative_path = ? ORDER BY v.captured_at DESC`).all(identity.repository_id, relativePath)
      : opened.db.prepare(`${base} ORDER BY v.relative_path, v.captured_at DESC`).all(identity.repository_id);
    return {
      status: row.enabled === 1 ? 'enabled' : 'disabled', database_path: databasePath, ...identity,
      versions: rows.map((entry) => ({ ...entry, bytes: Number(entry.bytes), is_current: entry.is_current === 1 })),
    };
  } finally {
    opened.db.close();
  }
}

function restoreVersion(projectRoot, options = {}) {
  const relativePath = normalizeSlashes(options.relativePath).replace(/^\.\//, '');
  const contentSha256 = String(options.contentSha256 || '').toLowerCase();
  if (!isDurablePath(relativePath)) {
    const error = new Error(`Version path is not eligible durable memory: ${relativePath || '(missing)'}`);
    error.code = 'CITADEL_MEMORY_PATH_UNSUPPORTED';
    throw error;
  }
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    const error = new Error('restore-version requires --sha256 with a full stored content digest.');
    error.code = 'CITADEL_MEMORY_VERSION_REQUIRED';
    throw error;
  }
  const databasePath = options.databasePath || defaultDatabasePath(options);
  if (!fs.existsSync(databasePath)) return { status: 'not-configured', database_path: databasePath };
  const identity = repositoryIdentity(projectRoot, options);
  const opened = openDatabase({ ...options, databasePath });
  try {
    const repository = repositoryRow(opened.db, identity.repository_id);
    if (!repository || repository.enabled !== 1) {
      return { status: 'disabled', database_path: databasePath, ...identity, relative_path: relativePath };
    }
    const entry = opened.db.prepare(`
      SELECT relative_path, content, content_sha256, bytes, captured_at
      FROM entry_versions WHERE repository_id = ? AND relative_path = ? AND content_sha256 = ?
    `).get(identity.repository_id, relativePath, contentSha256);
    if (!entry) return { status: 'version-not-found', database_path: databasePath, ...identity, relative_path: relativePath };
    const destination = path.resolve(identity.project_root, ...relativePath.split('/'));
    if (normalizedRelative(identity.project_root, destination) !== relativePath
      || pathContainsSymlink(identity.project_root, relativePath)) {
      return { status: 'conflict', reason: 'unsafe-or-symlink-destination', database_path: databasePath, ...identity, relative_path: relativePath };
    }
    const content = Buffer.from(entry.content);
    if (content.length !== entry.bytes || sha256(content) !== entry.content_sha256) {
      return { status: 'corrupt-version', database_path: databasePath, ...identity, relative_path: relativePath };
    }
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { status: 'conflict', reason: 'destination-is-not-a-plain-file', database_path: databasePath, ...identity, relative_path: relativePath };
      }
      const localSha256 = sha256(fs.readFileSync(destination));
      if (localSha256 !== contentSha256 && !options.force) {
        return { status: 'conflict', reason: 'different-local-content', local_sha256: localSha256, stored_sha256: contentSha256, database_path: databasePath, ...identity, relative_path: relativePath };
      }
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
    const now = new Date().toISOString();
    withTransaction(opened.db, () => {
      opened.db.prepare(`
        UPDATE entries SET content = ?, content_sha256 = ?, bytes = ?, captured_at = ?
        WHERE repository_id = ? AND relative_path = ?
      `).run(content, contentSha256, content.length, now, identity.repository_id, relativePath);
      opened.db.prepare('UPDATE repositories SET updated_at = ?, last_restored_at = ? WHERE repository_id = ?')
        .run(now, now, identity.repository_id);
    });
    return { status: 'version-restored', database_path: databasePath, ...identity, relative_path: relativePath, content_sha256: contentSha256 };
  } finally {
    opened.db.close();
  }
}

function repositoryStatus(projectRoot, options = {}) {
  const databasePath = options.databasePath || defaultDatabasePath(options);
  const capability = sqliteCapability(options);
  if (!capability.available) return { status: 'unavailable', database_path: databasePath, ...capability };
  const identity = repositoryIdentity(projectRoot, options);
  if (!fs.existsSync(databasePath)) return { status: 'not-configured', database_path: databasePath, ...identity };
  const opened = openDatabase({ ...options, databasePath, DatabaseSync: capability.DatabaseSync });
  try {
    const row = repositoryRow(opened.db, identity.repository_id);
    if (!row) return { status: 'not-enabled', database_path: databasePath, ...identity };
    const entryCount = opened.db.prepare('SELECT COUNT(*) AS count FROM entries WHERE repository_id = ?').get(identity.repository_id).count;
    const versionCount = opened.db.prepare('SELECT COUNT(*) AS count FROM entry_versions WHERE repository_id = ?').get(identity.repository_id).count;
    return {
      status: row.enabled === 1 ? 'enabled' : 'disabled', database_path: databasePath, ...identity,
      entries: Number(entryCount), versions: Number(versionCount),
      last_synced_at: row.last_synced_at, last_restored_at: row.last_restored_at,
    };
  } finally {
    opened.db.close();
  }
}

function disableRepository(projectRoot, options = {}) {
  const databasePath = options.databasePath || defaultDatabasePath(options);
  if (!fs.existsSync(databasePath)) return { status: 'not-configured', database_path: databasePath };
  const identity = repositoryIdentity(projectRoot, options);
  const opened = openDatabase({ ...options, databasePath });
  try {
    const result = opened.db.prepare(`
      UPDATE repositories SET enabled = 0, updated_at = ? WHERE repository_id = ?
    `).run(new Date().toISOString(), identity.repository_id);
    return { status: Number(result.changes || 0) ? 'disabled' : 'not-enabled', database_path: databasePath, ...identity };
  } finally {
    opened.db.close();
  }
}

function purgeRepository(projectRoot, options = {}) {
  if (options.confirm !== 'PURGE') {
    const error = new Error('Purge requires --confirm PURGE. This deletes every stored version for the current repository.');
    error.code = 'CITADEL_MEMORY_CONFIRMATION_REQUIRED';
    throw error;
  }
  const databasePath = options.databasePath || defaultDatabasePath(options);
  if (!fs.existsSync(databasePath)) return { status: 'not-configured', database_path: databasePath };
  const identity = repositoryIdentity(projectRoot, options);
  const opened = openDatabase({ ...options, databasePath });
  try {
    const result = opened.db.prepare('DELETE FROM repositories WHERE repository_id = ?').run(identity.repository_id);
    return { status: Number(result.changes || 0) ? 'purged' : 'not-enabled', database_path: databasePath, ...identity };
  } finally {
    opened.db.close();
  }
}

module.exports = Object.freeze({
  DURABLE_DIRECTORIES,
  DURABLE_FILES,
  MAX_ENTRY_BYTES,
  MAX_SYNC_BYTES,
  MIN_SQLITE_NODE_MAJOR,
  MIN_SQLITE_NODE_MINOR,
  MIN_SQLITE_NODE_VERSION,
  SCHEMA_VERSION,
  collectDurableEntries,
  defaultDatabasePath,
  disableRepository,
  enableRepository,
  isDurablePath,
  normalizeRemoteUrl,
  pathContainsSymlink,
  purgeRepository,
  repositoryIdentity,
  repositoryStatus,
  restoreRepository,
  restoreVersion,
  sha256,
  sqliteCapability,
  syncRepository,
  listVersions,
});
