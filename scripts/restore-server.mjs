// Puts a backup of a test server back into its database: npm run restore:server -- [<backup.sql>] [--dry-run] [--config=deploy.other.json]
// Without a file it takes the newest backup in the server's folder: the server database before the last push or restore:server.
// Only dumps these scripts made of the same server; the current server database is saved first, so a restore can be undone the same way.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describeDatabase, diffDumps, parseDump } from './db-changes.mjs';
import { readDumpEnd, readDumpStart } from './local-db.mjs';
import {
    DUMP_END, SyncError, TEMP_TABLES, checkTestServer, downloadDump, importOnServer, latestSnapshot, newestBackup, readConfig, readDumpHeader,
    replacePairs, reportPrunedBackups, serverBackupDir, shownPath, snapshotFile, stamp,
} from './sync.mjs';
import { createTimer } from './timer.mjs';

const args = process.argv.slice(2);
const configName = args.find((arg) => arg.startsWith('--config='))?.slice(9) || 'deploy.config.json';
const dryRun = args.includes('--dry-run');
const fileArg = args.find((arg) => !arg.startsWith('--'));
const time = stamp();
const timer = createTimer();
// Deleted if the restore stops before the import: the newest backup must be the state before the last restore that changed the server.
let unusedBackup = null;

const confirm = async (config) => {
    if (!process.stdin.isTTY) throw new SyncError('restore:server asks for confirmation: run it in a terminal.');

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const cancel = new AbortController();

    readline.on('SIGINT', () => cancel.abort());

    try {
        const answer = await readline.question(`\nThis replaces the database on ${config.siteHost} with the backup. Type ${config.siteHost} to continue: `, { signal: cancel.signal });

        if (answer.trim() !== config.siteHost) throw new SyncError('not confirmed, nothing was changed.');
    } catch (error) {
        throw error.name === 'AbortError' ? new SyncError('cancelled, nothing was changed.') : error;
    } finally {
        readline.close();
    }
};

const hostOf = (url) => {
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
};

// The importer loads tables named TEMP_TABLES + name; in these dumps statements start their lines and rows start with "(".
const toTempTables = (sql) => sql.replace(/^(DROP TABLE IF EXISTS |CREATE TABLE |INSERT INTO )`/gm, `$1\`${TEMP_TABLES}`);

const readBackup = (file) => {
    const data = readFileSync(file);

    return (data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data).toString('latin1');
};

// Changes on the server since the last snapshot (someone edited the dev site after your push): the restore removes them too.
// Shown, not stopping: going back is what restore:server is for, and the current state is saved first.
const reportServerChanges = (config, prefix, currentFile, safety) => {
    const snapshot = latestSnapshot(config, '.sql');

    if (!snapshot) {
        console.log('  There is no snapshot of the server yet, so changes made on it since cannot be shown.');
        return;
    }

    const base = parseDump(snapshot.file);
    const current = parseDump(currentFile);
    const { lines } = describeDatabase(diffDumps(base, current), prefix, [current, base]);
    const since = snapshot.takenAt.toLocaleString();

    if (!lines.length) {
        console.log(`  The server has not changed since the last pull, push or restore:server (${since}).`);
        return;
    }

    console.log([
        `\nSince the last pull, push or restore:server (${since}) the server has changed:`,
        ...lines.map((line) => `  ${line}`),
        `The restore removes these changes too${dryRun ? '' : `; they stay in ${shownPath(safety)}`}.`,
    ].join('\n'));
};

const restoreServer = async () => {
    if (path.basename(configName) === 'deploy.prod.json') throw new SyncError('restore:server never runs against production (deploy.prod.json).');

    const config = readConfig(configName);
    const dir = serverBackupDir(config);

    // npm runs scripts in the theme folder; INIT_CWD is the folder the command was typed in.
    const file = fileArg
        ? path.resolve(process.env.INIT_CWD || process.cwd(), fileArg)
        : newestBackup(dir, ['backup-before-push', 'backup-before-restore'], '.sql')?.file;

    if (!file) throw new SyncError(`there are no backups of ${config.siteHost} in ${shownPath(dir)} yet. Name the file: npm run restore:server -- <file.sql>`);
    if (!existsSync(file)) throw new SyncError(`${file} not found.`);
    if (file.endsWith('.part')) throw new SyncError(`${shownPath(file)} is an unfinished file. Nothing was changed.`);

    const header = readDumpHeader(readDumpStart(file));

    if (!header.prefix) {
        throw new SyncError(`${shownPath(file)} was not made by these scripts: restore:server takes only the backups and snapshots that push, pull and restore:server save. Nothing was changed.`);
    }

    if (!(await readDumpEnd(file)).trimEnd().endsWith(DUMP_END)) {
        throw new SyncError(`${shownPath(file)} is incomplete: its end marker is missing. Nothing was changed.`);
    }

    if (hostOf(header.home) !== config.siteHost) {
        throw new SyncError(`the backup comes from ${header.home || 'an unknown site'}, not from ${config.siteUrl}. restore:server takes only backups of the same server; a local database goes to the server with npm run push. Nothing was changed.`);
    }

    await checkTestServer(config, 'restore:server');
    timer.lap('test server check');

    const safety = path.join(dir, `backup-before-restore-${time}.sql`);
    const currentFile = dryRun ? path.join(os.tmpdir(), `restore-check-${time}.sql`) : safety;

    console.log('\nRestore on the server');
    console.log(`  backup: ${shownPath(file)}${fileArg ? '' : ' (the newest one)'}`);
    console.log(`  to: ${config.siteUrl}`);
    if (!dryRun) console.log(`  the server database is saved first: ${shownPath(safety)}`);
    console.log('  only the database changes: uploads and plugins stay as they are.');
    console.log('  downloading the server database to compare …');

    mkdirSync(dir, { recursive: true });
    if (!dryRun) unusedBackup = safety;

    let server;

    try {
        server = await downloadDump(config, currentFile);
        timer.lap('server database download');

        if (server.prefix !== header.prefix) {
            throw new SyncError(`the backup has the table prefix "${header.prefix}", the server uses "${server.prefix}". Nothing was changed.`);
        }

        reportServerChanges(config, header.prefix, currentFile, safety);
        timer.lap('compare');
    } finally {
        if (dryRun && existsSync(currentFile)) unlinkSync(currentFile);
    }

    if (dryRun) {
        console.log('\nDry run: nothing was changed.');
        return;
    }

    await confirm(config);
    timer.lap('waiting for your confirmation');

    const body = gzipSync(Buffer.from(toTempTables(readBackup(file)), 'latin1'));

    console.log('\n  importing the backup …');
    unusedBackup = null;
    await importOnServer(config, header.prefix, replacePairs(header, server), body);
    timer.lap('upload and import');

    console.log('  saving a new snapshot of the server …');

    try {
        await downloadDump(config, snapshotFile(config, time, '.sql'));
        timer.lap('new snapshot');
    } catch (error) {
        console.log(`  The database was restored, but the new snapshot could not be saved (${error.message}).`);
        console.log('  The next push will list the restored data as server changes: if that is all it lists, push with --force.');
    }

    reportPrunedBackups(config);
    console.log(`\nRestore finished. Tables the backup does not contain were left as they are.\nTo undo it: npm run restore:server -- "${safety}"`);
};

try {
    await restoreServer();
} catch (error) {
    if (unusedBackup) rmSync(unusedBackup, { force: true });
    console.error(`\nRestore stopped: ${error instanceof SyncError ? error.message : error.stack || error}`);
    process.exitCode = 1;
} finally {
    console.log(timer.summary());
}
