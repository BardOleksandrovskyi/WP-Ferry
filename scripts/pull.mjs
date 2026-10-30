// Pulls the dev server into the Local site: database (with URL replacement), wp-content/uploads and wp-content/plugins.
// Usage: npm run pull -- [--dry-run] [--db-only] [--uploads-only] [--plugins-only] [--keep-local] [--legacy-db] [--config=deploy.other.json]
// The local database is found through Local, wp-config.php or localDb in the config (see local-db.mjs).
// Each pull saves a snapshot of the server in its backups folder; push compares the server with it before overwriting anything.
import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { localPhpVersion, localUrls, openLocalDatabase } from './local-db.mjs';
import {
    diffPlugins, downloadPlugins, listLocalPlugins, listServerPlugins, printPluginPlan, removeLocalPlugins, savePluginsSnapshot,
    uncommittedPlugins, unmetRequirements, writeLocalPlugins,
} from './plugins.mjs';
import {
    IGNORED_UPLOADS, SyncError, compareCore, connect, downloadDump, listLocal, listServerUploads, localBackupDir, localCore, localPrefix,
    printList, replacePairs, readConfig, reportPrunedBackups, saveUploadsSnapshot, serverBackupDir, serverCore, shownPath, snapshotFile, stamp, uploadsDir,
} from './sync.mjs';
import { createTimer } from './timer.mjs';

const args = new Set(process.argv.slice(2));
const configName = [...args].find((arg) => arg.startsWith('--config='))?.slice(9) || 'deploy.config.json';
const dryRun = args.has('--dry-run');
const keepLocal = args.has('--keep-local');
const legacyDb = args.has('--legacy-db');
const only = ['db', 'uploads', 'plugins'].filter((part) => args.has(`--${part}-only`));
const withDb = !only.length || only.includes('db');
const withUploads = !only.length || only.includes('uploads');
const withPlugins = !only.length || only.includes('plugins');
const time = stamp();
const stops = [];
const timer = createTimer();
let local = null;
// Deleted if the pull stops before the import: the newest backup must be the state before the last pull that changed the database.
let unusedBackup = null;

const pullDatabase = async (config) => {
    const prefix = localPrefix();
    const backupFile = path.join(localBackupDir(), `backup-before-pull-${time}.sql`);
    const dumpFile = snapshotFile(config, time, '.sql');
    const target = await localUrls(local, prefix);

    console.log('\nDatabase');
    console.log(`  from: ${config.siteUrl}`);
    console.log(`  into: ${local.database} (${local.label}), URLs become ${target.home}`);
    if (!target.fromOptions) console.log(`  the local site address is not in the database: it is taken from ${local.domain ? 'Local' : 'WP_HOME in wp-config.php'}.`);
    console.log(`  local backup: ${shownPath(backupFile)}`);

    if (dryRun) return;

    mkdirSync(localBackupDir(), { recursive: true });
    mkdirSync(serverBackupDir(config), { recursive: true });

    console.log('  backing up the local database …');
    await local.backup(backupFile, prefix);
    unusedBackup = backupFile;
    timer.lap('database: local backup');

    console.log('  downloading the server database …');
    const server = await downloadDump(config, dumpFile);
    timer.lap('database: download');

    if (server.prefix !== prefix) {
        unlinkSync(dumpFile);
        throw new SyncError(`the server table prefix "${server.prefix}" differs from the local "${prefix}". Nothing was imported. Set $table_prefix = '${server.prefix}'; in the local wp-config.php (fine for a fresh local site: the pull brings all tables) and run this again.`);
    }

    console.log(`  saved: ${shownPath(dumpFile)} (${server.tables.length} tables)`);
    console.log('  importing …');

    const restoreHint = `The local database may be incomplete. Put it back with:\n  npm run restore -- "${backupFile}"${legacyDb ? ' --legacy-db' : ''}`;
    const onCtrlC = () => {
        console.error(`\n\nPull interrupted during the import. ${restoreHint}`);
        process.exit(130);
    };

    process.once('SIGINT', onCtrlC);
    unusedBackup = null;

    try {
        await local.importDump(dumpFile);
        timer.lap('database: import');

        const pairs = replacePairs(server, target);

        if (pairs.length) {
            console.log(`  replacing ${server.home} → ${target.home} …`);
            Object.entries(await local.replaceUrls(prefix, pairs)).forEach(([table, count]) => console.log(`    ${table}: ${count}`));
            timer.lap('database: URLs');
        }
    } catch (error) {
        throw new SyncError(`${error.message}\n${restoreHint}`);
    } finally {
        process.off('SIGINT', onCtrlC);
    }

    const extra = (await local.query(`SHOW TABLES LIKE '${prefix.replace(/_/g, '\\_')}%'`)).map(([table]) => table).filter((table) => !server.tables.includes(table));

    if (extra.length) console.log(`  local-only tables kept: ${extra.join(', ')}`);

    console.log('  database done. Log in with your dev server user.');
};

const pullUploads = async (config) => {
    const remoteUploads = `${config.remoteContent}/uploads`;

    console.log('\nUploads');
    console.log('  reading the file lists …');

    const remote = await listServerUploads(config);
    const local = listLocal(uploadsDir);

    timer.lap('uploads: compare');

    const toDownload = [...remote.keys()].filter((name) => !IGNORED_UPLOADS.test(name) && local.get(name) !== remote.get(name)).sort();
    const localOnly = [...local.keys()].filter((name) => !IGNORED_UPLOADS.test(name) && !remote.has(name)).sort();

    console.log(`  server: ${remote.size} files, local: ${local.size} files`);
    printList('To download', toDownload, '+');
    printList(keepLocal ? 'Local-only, kept (--keep-local)' : 'Local-only, to delete', localOnly, keepLocal ? '=' : '-');

    if (dryRun) return;

    let client = toDownload.length ? await connect(config) : null;

    try {
        for (const [index, name] of toDownload.entries()) {
            const target = path.join(uploadsDir, ...name.split('/'));

            mkdirSync(path.dirname(target), { recursive: true });

            try {
                await client.downloadTo(target, `${remoteUploads}/${name}`);
            } catch (error) {
                if (typeof error?.code === 'number') throw new SyncError(`${name}: ${error.message}`);

                client.close();
                client = await connect(config);
                await client.downloadTo(target, `${remoteUploads}/${name}`);
            }

            if ((index + 1) % 50 === 0 || index + 1 === toDownload.length) console.log(`  downloaded ${index + 1}/${toDownload.length}`);
        }

        if (!keepLocal) localOnly.forEach((name) => unlinkSync(path.join(uploadsDir, ...name.split('/'))));

        mkdirSync(serverBackupDir(config), { recursive: true });
        saveUploadsSnapshot(config, time, remote);
        timer.lap('uploads: download');

        console.log(`  uploads done: ${toDownload.length} downloaded, ${keepLocal ? 0 : localOnly.length} deleted.`);
    } finally {
        client?.close();
    }
};

const planPlugins = async (config, core) => {
    console.log('\nPlugins');
    console.log('  reading the file lists …');

    const server = await listServerPlugins(config);
    timer.lap('plugins: server file list');

    const local = listLocalPlugins();
    timer.lap('plugins: local file list');

    const plan = diffPlugins(server.plugins, local);
    const removing = keepLocal ? [] : plan.extra.map(({ name }) => name);
    const uncommitted = uncommittedPlugins();
    timer.lap('plugins: git status');
    const blocked = [...plan.changes.map(({ name }) => name), ...removing].filter((name) => uncommitted.has(name));

    const unmet = unmetRequirements(server.plugins, plan.changes, 'the local site', core.wp, localPhpVersion());

    console.log(`  server: ${Object.keys(server.plugins).length} plugins, local: ${Object.keys(local).length} plugins`);
    printPluginPlan(plan, keepLocal ? 'Local-only, kept (--keep-local)' : 'Local-only, to delete', keepLocal ? '=' : '-');

    if (unmet.length) {
        stops.push(['plugins from the server need newer software:', ...unmet.map((line) => `  ${line}`), 'Update WordPress or PHP in Local first.'].join('\n'));
    }

    if (blocked.length) {
        const files = blocked.flatMap((name) => uncommitted.get(name));

        stops.push([
            'uncommitted changes in plugins the pull would overwrite:',
            ...files.slice(0, 20).map((file) => `  ${file}`),
            ...(files.length > 20 ? [`  … and ${files.length - 20} more`] : []),
            'Commit or discard them first.',
        ].join('\n'));
    }

    return { server, changes: plan.changes, removing };
};

const pullPlugins = async (config, { server, changes, removing }) => {
    console.log('\nPulling plugins …');

    const wanted = Object.fromEntries(changes
        .map((change) => [change.name, [...change.added, ...change.changed]])
        .filter(([, files]) => files.length));
    const count = Object.values(wanted).flat().length;

    if (count) console.log(`  downloading ${count} files …`);

    writeLocalPlugins(changes, count ? await downloadPlugins(config, wanted) : new Map());
    removeLocalPlugins(removing);

    mkdirSync(serverBackupDir(config), { recursive: true });
    savePluginsSnapshot(config, time, server.plugins);
    timer.lap('plugins: download');

    console.log(`  plugins done: ${changes.length} updated, ${removing.length} deleted.`);
    if (changes.length || removing.length) console.log('  Review the plugin changes in git and commit them.');
};

const pull = async () => {
    const config = readConfig(configName);

    if (withDb) local = await openLocalDatabase(config, { legacy: legacyDb });

    const core = localCore();
    const coreProblem = compareCore(core, await serverCore(config), false, withDb);

    timer.lap('WordPress versions');
    if (coreProblem) stops.push(coreProblem);

    const plugins = withPlugins ? await planPlugins(config, core) : null;

    stops.forEach((message) => console.log(`\n${dryRun ? 'A real pull would stop' : 'Stop'}: ${message}`));
    if (stops.length && !dryRun) throw new SyncError('nothing was changed.');

    if (withDb) await pullDatabase(config);
    if (withUploads) await pullUploads(config);
    if (plugins && !dryRun) await pullPlugins(config, plugins);
    if (!dryRun) reportPrunedBackups(config);

    console.log(dryRun ? '\nDry run: nothing was changed.' : '\nPull finished.');
};

try {
    await pull();
} catch (error) {
    if (unusedBackup) rmSync(unusedBackup, { force: true });
    console.error(`\nPull stopped: ${error instanceof SyncError ? error.message : error.stack || error}`);
    process.exitCode = 1;
} finally {
    await local?.close();
    console.log(timer.summary());
}
