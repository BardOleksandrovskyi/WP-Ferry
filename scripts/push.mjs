// Pushes the Local site to the dev server: database (with URL replacement), wp-content/uploads and wp-content/plugins.
// Usage: npm run push -- [--dry-run] [--db-only] [--uploads-only] [--plugins-only] [--mirror] [--force] [--legacy-db] [--config=deploy.other.json]
// Never runs against production: the server's wp-config.php must set WP_ENVIRONMENT_TYPE to staging or development, and deploy.prod.json is refused.
// Before overwriting anything it compares the server with the snapshot
// from your last pull or push and stops if someone changed it since; --force pushes anyway. The server database is backed up to the server's backups folder first.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describeDatabase, diffDumps, parseDump } from './db-changes.mjs';
import { localUrls, openLocalDatabase } from './local-db.mjs';
import { createTimer } from './timer.mjs';
import {
    compareVersions, diffPlugins, listLocalPlugins, listServerPlugins, pluginSnapshot, printPluginPlan, savePluginsSnapshot,
    unmetRequirements, uploadPlugins,
} from './plugins.mjs';
import {
    DUMP_END, IGNORED_UPLOADS, PHP_COMMON, SyncError, TEMP_TABLES, callServerScript, checkTestServer, compareCore, connect, downloadDump, importOnServer,
    latestSnapshot, listLocal, listServerUploads, localCore, localPrefix, portableCollations, printList, readConfig, readScriptResult, replacePairs, reportPrunedBackups,
    saveUploadsSnapshot, serverBackupDir, serverCore, shownPath, snapshotFile, stamp, uploadsDir,
} from './sync.mjs';

const args = new Set(process.argv.slice(2));
const configName = [...args].find((arg) => arg.startsWith('--config='))?.slice(9) || 'deploy.config.json';
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const mirror = args.has('--mirror');
const legacyDb = args.has('--legacy-db');
const only = ['db', 'uploads', 'plugins'].filter((part) => args.has(`--${part}-only`));
const withDb = !only.length || only.includes('db');
const withUploads = !only.length || only.includes('uploads');
const withPlugins = !only.length || only.includes('plugins');
const time = stamp();
const timer = createTimer();
let local = null;
// Deleted if the push stops before changing the server: the newest backup must be the state before the last push that changed it.
let unusedBackup = null;

const IMAGES = /\.(jpe?g|png|gif|webp)$/i;

// Converts pushed images with WebP Converter on the server and counts the copies it made; skipped if the plugin is not active.
const WEBP_CONVERTER = String.raw`<?php
` + PHP_COMMON + String.raw`
sync_guard();

define('WP_USE_THEMES', false);
require __DIR__ . '/wp-load.php';

while (ob_get_level()) ob_end_clean();

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
header('X-Accel-Buffering: no');

function webp_say($line)
{
    echo $line, "\n";
    @flush();
}

if (!has_action('webpc_convert_paths')) {
    webp_say('DONE ' . json_encode(['active' => false]));
    exit;
}

$uploads = wp_upload_dir()['basedir'];
$content = dirname((string) apply_filters('webpc_dir_path', '', 'uploads'));
$output = (string) apply_filters('webpc_dir_path', '', 'webp');
$settings = get_option('webpc_settings');
$extensions = array_map('strtolower', (array) ($settings['extensions'] ?? ['jpg', 'jpeg', 'png']));
$formats = array_map('strtolower', (array) ($settings['output_formats'] ?? ['webp']));
$result = ['active' => true, 'images' => 0, 'formats' => array_fill_keys($formats, 0)];

// WordPress adds slashes to $_POST when it loads, which breaks the JSON.
$files = json_decode(wp_unslash((string) ($_POST['files'] ?? '')), true);

if (!is_array($files)) {
    webp_say('ERROR the list of images could not be read');
    exit;
}

webp_say('converting ' . count($files) . ' images');

foreach ($files as $name) {
    $name = (string) $name;
    $source = "{$uploads}/{$name}";

    if (preg_match('#(^|/)\.\.?(/|$)|^/|\\\\|\x00#', $name) || !is_file($source)) continue;
    if (!in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), $extensions, true)) continue;

    $copies = [];

    if (strpos($source, "{$content}/") === 0) {
        foreach ($formats as $format) {
            $copies[$format] = $output . substr($source, strlen($content)) . ".{$format}";
            @unlink($copies[$format]);
            @unlink("{$copies[$format]}.deleted");
        }
    }

    do_action('webpc_convert_paths', [$source], true);
    $result['images']++;

    foreach ($copies as $format => $copy) {
        if (is_file($copy) || is_file("{$copy}.deleted") || strtolower(pathinfo($name, PATHINFO_EXTENSION)) === $format) $result['formats'][$format]++;
    }

    webp_say($result['images'] % 10 === 0 ? "converted {$result['images']} images" : '');
}

webp_say('DONE ' . json_encode($result));
`;

const describeUploads = (baseline, remote) => {
    const lines = [];
    let ignored = 0;

    for (const name of [...new Set([...Object.keys(baseline), ...remote.keys()])].sort()) {
        const before = baseline[name];
        const after = remote.get(name);

        if (before === after) continue;

        if (IGNORED_UPLOADS.test(name)) {
            ignored += 1;
            continue;
        }

        lines.push(`  ${before === undefined ? '+' : after === undefined ? '-' : '~'} ${name}`);
    }

    return { lines: lines.length ? ['Uploads:', ...lines] : [], ignored };
};

const confirm = async (config) => {
    if (!process.stdin.isTTY) throw new SyncError('push asks for confirmation: run it in a terminal.');

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const cancel = new AbortController();

    readline.on('SIGINT', () => cancel.abort());

    try {
        const parts = [withDb && 'the database', withUploads && 'uploads', withPlugins && 'plugins'].filter(Boolean).join(', ');
        const answer = await readline.question(`\nThis overwrites ${parts} on ${config.siteHost}. Type ${config.siteHost} to continue: `, { signal: cancel.signal });

        if (answer.trim() !== config.siteHost) throw new SyncError('not confirmed, nothing was changed.');
    } catch (error) {
        throw error.name === 'AbortError' ? new SyncError('cancelled, nothing was changed.') : error;
    } finally {
        readline.close();
    }
};

const planDatabase = async (config, prefix, report) => {
    const snapshot = latestSnapshot(config, '.sql');
    const backupFile = path.join(serverBackupDir(config), `backup-before-push-${time}.sql`);
    const currentFile = dryRun ? path.join(os.tmpdir(), `push-check-${time}.sql`) : backupFile;
    const source = await localUrls(local, prefix);

    console.log('\nDatabase');
    console.log(`  from: ${local.database} (${local.label})`);
    console.log(`  to: ${config.siteUrl}`);
    if (!dryRun) console.log(`  server backup: ${shownPath(backupFile)}`);
    console.log('  downloading the server database to compare …');
    if (!dryRun) unusedBackup = backupFile;

    try {
        const server = await downloadDump(config, currentFile);

        timer.lap('database: download to compare');

        if (server.prefix !== prefix) {
            throw new SyncError(`the server table prefix "${server.prefix}" differs from the local "${prefix}".`);
        }

        console.log(`  URLs: ${source.home} → ${server.home}`);

        if (!snapshot) {
            report.problems.push('There is no snapshot of the server database from a pull: run npm run pull first.');
        } else {
            const base = parseDump(snapshot.file);
            const current = parseDump(currentFile);
            const described = describeDatabase(diffDumps(base, current), prefix, [current, base]);

            report.lines.push(...described.lines);
            report.activity.push(...described.activity);
            report.ignored += described.ignored;
            report.since = snapshot.takenAt;
            timer.lap('database: compare');
        }

        return { pairs: replacePairs(source, server), tables: server.tables };
    } finally {
        if (dryRun && existsSync(currentFile)) unlinkSync(currentFile);
    }
};

const planUploads = async (config, report) => {
    console.log('\nUploads');
    console.log('  reading the file lists …');

    const remote = await listServerUploads(config);
    const local = listLocal(uploadsDir);
    const toUpload = [...local.keys()].filter((name) => !IGNORED_UPLOADS.test(name) && remote.get(name) !== local.get(name)).sort();
    const serverOnly = [...remote.keys()].filter((name) => !IGNORED_UPLOADS.test(name) && !local.has(name)).sort();
    const snapshot = latestSnapshot(config, '.uploads.json');

    if (!snapshot) {
        report.problems.push('There is no snapshot of the server uploads from a pull: run npm run pull first.');
    } else {
        const described = describeUploads(JSON.parse(readFileSync(snapshot.file, 'utf8')), remote);

        report.lines.push(...described.lines);
        report.ignored += described.ignored;
        report.since ||= snapshot.takenAt;
    }

    timer.lap('uploads: compare');

    console.log(`  local: ${local.size} files, server: ${remote.size} files`);
    printList('To upload', toUpload, '+');
    printList(mirror ? 'Server-only, to delete (--mirror)' : 'Server-only, kept (add --mirror to delete)', serverOnly, mirror ? '-' : '=');

    return { remote, local, toUpload, serverOnly };
};

const planPlugins = async (config, report, core) => {
    console.log('\nPlugins');
    console.log('  reading the file lists …');

    const server = await listServerPlugins(config);
    timer.lap('plugins: server file list');

    const local = listLocalPlugins();
    timer.lap('plugins: local file list');

    const plan = diffPlugins(local, server.plugins);
    const removing = mirror ? plan.extra.map(({ name }) => name) : [];
    const snapshot = latestSnapshot(config, '.plugins.json');

    console.log(`  local: ${Object.keys(local).length} plugins, server: ${Object.keys(server.plugins).length} plugins`);
    printPluginPlan(plan, mirror ? 'Server-only, to remove (--mirror)' : 'Server-only, kept (add --mirror to remove)', mirror ? '-' : '=');

    plan.changes
        .filter((change) => !change.isNew && compareVersions(change.from, change.to) > 0)
        .forEach((change) => report.problems.push(`${change.name} is newer on the server (${change.from}) than locally (${change.to}). Update it locally and commit, or the push downgrades it.`));

    const unmet = unmetRequirements(local, plan.changes, 'the server', core.wp, server.php);

    if (unmet.length) {
        report.problems.push(['plugins need newer software than the server has, the site could break:', ...unmet.map((line) => `  ${line}`), 'Update WordPress or PHP on the server first.'].join('\n'));
    }

    if (!snapshot) {
        console.log('  No snapshot of the server plugins from a pull yet: only the versions were compared.');
    } else {
        const base = JSON.parse(readFileSync(snapshot.file, 'utf8'));
        const current = pluginSnapshot(server.plugins);
        const lines = [...plan.changes.map(({ name }) => name), ...removing]
            .filter((name) => base[name]?.hash !== current[name]?.hash)
            .map((name) => {
                if (!base[name]) return `  + ${name} ${current[name].version} — added on the server`;
                if (!current[name]) return `  - ${name} ${base[name].version} — removed from the server`;

                const versions = base[name].version === current[name].version ? current[name].version : `${base[name].version} → ${current[name].version}`;

                return `  ~ ${name} ${versions} — changed on the server`;
            });

        if (lines.length) report.lines.push('Plugins:', ...lines);
        report.since ||= snapshot.takenAt;
    }

    return { server, local, changes: plan.changes, removing };
};

const pushPlugins = async (config, { server, local, changes, removing }) => {
    console.log('\nPushing plugins …');

    await uploadPlugins(config, local, changes, removing);
    timer.lap('plugins: upload');

    const after = { ...server.plugins };

    changes.forEach(({ name }) => { after[name] = local[name]; });
    removing.forEach((name) => delete after[name]);
    savePluginsSnapshot(config, time, after);

    console.log(`  plugins done: ${changes.length} updated, ${removing.length} moved to wp-content/_rollback.`);

    if (withDb) return;

    changes.filter((change) => change.isNew).forEach(({ name }) => console.log(`  ${name} is new on the server and not active: activate it in Plugins there.`));
    removing.filter((name) => server.active?.some((file) => file.startsWith(`${name}/`))).forEach((name) => console.log(`  ${name} was active on the server: WordPress turns it off on the next admin visit.`));
    if (changes.some((change) => !change.isNew && change.from !== change.to)) console.log('  Open the server admin once: updated plugins may need to update their database tables.');
};

const prepareDatabase = async (prefix, tables) => {
    console.log('\nDumping the local database …');

    const dumpFile = path.join(os.tmpdir(), `push-${time}.sql.gz`);

    try {
        await local.dump(prefix, dumpFile, TEMP_TABLES, tables);
        timer.lap('database: local dump');

        const sql = gunzipSync(readFileSync(dumpFile)).toString('latin1');

        if (!sql.trimEnd().endsWith(DUMP_END)) throw new SyncError('the local database dump is incomplete.');

        return gzipSync(Buffer.from(portableCollations(sql), 'latin1'));
    } finally {
        if (existsSync(dumpFile)) unlinkSync(dumpFile);
    }
};

const pushDatabase = async (config, prefix, pairs, body) => {
    console.log('\nPushing the database …');

    await importOnServer(config, prefix, pairs, body);
    timer.lap('database: upload and import');

    console.log('  saving a new snapshot of the server …');

    // The database is already replaced: a failed snapshot must not stop the uploads.
    try {
        await downloadDump(config, snapshotFile(config, time, '.sql'));
        timer.lap('database: new snapshot');
    } catch (error) {
        console.log(`  The database was replaced, but the new snapshot could not be saved (${error.message}).`);
        console.log("  The next push will list this push's own changes as server changes: if that is all it lists, push with --force.");
    }
};

const pushUploads = async (config, { remote, local, toUpload, serverOnly }) => {
    console.log('\nPushing uploads …');

    const remoteUploads = `${config.remoteContent}/uploads`;
    const remoteWebp = `${config.remoteContent}/uploads-webpc/uploads`;
    const ensured = new Set();
    let client = await connect(config);

    // WebP Converter keeps converted copies; stale ones would keep showing the old image.
    const removeWebp = async (name) => {
        for (const extension of ['.webp', '.avif', '.webp.deleted', '.avif.deleted']) {
            await client.remove(`${remoteWebp}/${name}${extension}`).catch(() => { });
        }
    };

    try {
        for (const [index, name] of toUpload.entries()) {
            const target = `${remoteUploads}/${name}`;
            const dir = path.posix.dirname(target);
            const send = async () => {
                if (!ensured.has(dir)) {
                    await client.ensureDir(dir);
                    ensured.add(dir);
                }

                await client.uploadFrom(path.join(uploadsDir, ...name.split('/')), target);
            };

            try {
                await send();
            } catch (error) {
                if (typeof error?.code === 'number') throw new SyncError(`${name}: ${error.message}`);

                client.close();
                client = await connect(config);
                ensured.clear();
                await send();
            }

            if (remote.has(name) && IMAGES.test(name)) await removeWebp(name);
            if ((index + 1) % 50 === 0 || index + 1 === toUpload.length) console.log(`  uploaded ${index + 1}/${toUpload.length}`);
        }

        if (mirror) {
            for (const name of serverOnly) {
                await client.remove(`${remoteUploads}/${name}`).catch((error) => console.log(`  could not delete ${name}: ${error.message}`));
                if (IMAGES.test(name)) await removeWebp(name);
            }
        }

        const after = new Map(remote);

        toUpload.forEach((name) => after.set(name, local.get(name)));
        if (mirror) serverOnly.forEach((name) => after.delete(name));

        saveUploadsSnapshot(config, time, after);
        timer.lap('uploads: upload');

        console.log(`  uploads done: ${toUpload.length} uploaded, ${mirror ? serverOnly.length : 0} deleted.`);
    } finally {
        client.close();
    }

    const images = toUpload.filter((name) => IMAGES.test(name));

    if (images.length) {
        await convertImages(config, images);
        timer.lap('uploads: WebP conversion');
    }
};

const convertImages = async (config, images) => {
    console.log('\nChecking WebP Converter on the server …');

    try {
        const result = await callServerScript(
            config,
            WEBP_CONVERTER,
            { files: JSON.stringify(images) },
            readScriptResult('the conversion failed', 'the conversion did not finish'),
        );

        if (!result.active) {
            console.log('  WebP Converter is not active on the server: skipped.');
            return;
        }

        if (!result.images) {
            console.log('  No images to convert.');
            return;
        }

        const formats = Object.entries(result.formats);

        console.log(`  converted: ${result.images} images${formats.map(([format, count]) => `, ${format} ${count}`).join('')}`);

        if (formats.some(([, count]) => count < result.images)) {
            console.log('  Not all copies were created: regenerate the images in WebP Converter on the server.');
        }
    } catch (error) {
        console.log(`  Could not convert the images (${error.message}). Regenerate them in WebP Converter on the server.`);
    }
};

const push = async () => {
    if (path.basename(configName) === 'deploy.prod.json') throw new SyncError('push never runs against production (deploy.prod.json).');

    const config = readConfig(configName);

    await checkTestServer(config, 'Push');
    timer.lap('test server check');

    if (withDb) local = await openLocalDatabase(config, { legacy: legacyDb });

    const prefix = localPrefix();
    const report = { lines: [], activity: [], problems: [], ignored: 0, since: null };

    mkdirSync(serverBackupDir(config), { recursive: true });

    const core = await serverCore(config);
    const coreProblem = compareCore(localCore(), core, true, withDb);

    timer.lap('WordPress versions');
    if (coreProblem) report.problems.push(coreProblem);

    const database = withDb ? await planDatabase(config, prefix, report) : null;
    const uploads = withUploads ? await planUploads(config, report) : null;
    const plugins = withPlugins ? await planPlugins(config, report, core) : null;

    const nothing = !database
        && (!uploads || (!uploads.toUpload.length && !(mirror && uploads.serverOnly.length)))
        && (!plugins || (!plugins.changes.length && !plugins.removing.length));

    if (nothing) {
        if (plugins && !dryRun) savePluginsSnapshot(config, time, plugins.server.plugins);
        console.log('\nNothing to push: the server already has the same files.');
        return;
    }

    if (report.lines.length) {
        report.problems.push([
            `Since your last pull, push or restore:server (${report.since.toLocaleString()}) the server has changed:`,
            ...report.lines.map((line) => `  ${line}`),
            'Your push would overwrite these changes.',
            '  1. Keep the server changes:  npm run pull  (your local changes are lost; redo them after the pull)',
            `  2. Overwrite the server:     npm run push -- --force  (the server database is backed up to ${shownPath(serverBackupDir(config))} first)`,
            '  3. Small changes: make them by hand in the dev server admin instead of pushing.',
        ].join('\n'));
    }

    if (report.ignored) console.log(`\nService changes on the server, ignored (caches, logs, queues): ${report.ignored}`);
    if (report.activity.length) {
        console.log(`\nActivity on the server since your last pull, push or restore:server, does not stop the push:\n${report.activity.map((line) => `  ${line}`).join('\n')}`);
    }

    report.problems.forEach((problem) => console.log(`\n${force ? 'Overridden by --force' : 'Stop'}: ${problem}`));

    if (dryRun) {
        console.log(report.problems.length && !force
            ? '\nDry run: nothing was changed. A real push would stop here; --force pushes anyway.'
            : '\nDry run: nothing was changed.');
        return;
    }

    if (report.problems.length && !force) throw new SyncError('nothing was changed on the server.');

    await confirm(config);
    timer.lap('waiting for your confirmation');

    let body = null;

    if (database) {
        // A fresh connection: the old one may have timed out while waiting for the confirmation; the dump is made before anything changes on the server.
        await local.close();
        local = await openLocalDatabase(config, { legacy: legacyDb });
        body = await prepareDatabase(prefix, database.tables);
    }

    unusedBackup = null;

    if (plugins && (plugins.changes.length || plugins.removing.length)) await pushPlugins(config, plugins);
    if (database) await pushDatabase(config, prefix, database.pairs, body);
    if (uploads) await pushUploads(config, uploads);

    reportPrunedBackups(config);
    console.log('\nPush finished.');
};

try {
    await push();
} catch (error) {
    if (unusedBackup) rmSync(unusedBackup, { force: true });
    console.error(`\nPush stopped: ${error instanceof SyncError ? error.message : error.stack || error}`);
    process.exitCode = 1;
} finally {
    await local?.close();
    console.log(timer.summary());
}
