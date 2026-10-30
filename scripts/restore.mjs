// Usage: npm run restore -- [<backup.sql>] [--dry-run] [--legacy-db] [--config=deploy.other.json]. Saves the current state first.
// Without a file it takes the newest backup in local/: the local database before the last pull or restore.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
    localUrls, openLocalDatabase, readDumpEnd, readDumpStart,
} from './local-db.mjs';
import {
    DUMP_END, SyncError, localBackupDir, localPrefix, newestBackup, readDumpHeader, readLocalConfig, replacePairs, reportPrunedBackups, shownPath, stamp,
} from './sync.mjs';
import { createTimer } from './timer.mjs';

const args = process.argv.slice(2);
const configName = args.find((arg) => arg.startsWith('--config='))?.slice(9) || 'deploy.config.json';
const legacyDb = args.includes('--legacy-db');
const dryRun = args.includes('--dry-run');
const fileArg = args.find((arg) => !arg.startsWith('--'));
const timer = createTimer();
let local = null;

const confirm = async (database) => {
    if (!process.stdin.isTTY) throw new SyncError('restore asks for confirmation: run it in a terminal.');

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const cancel = new AbortController();

    readline.on('SIGINT', () => cancel.abort());

    try {
        const answer = await readline.question(`\nThis replaces the tables of ${database} that the backup contains. Type ${database} to continue: `, { signal: cancel.signal });

        if (answer.trim() !== database) throw new SyncError('not confirmed, nothing was changed.');
    } catch (error) {
        throw error.name === 'AbortError' ? new SyncError('cancelled, nothing was changed.') : error;
    } finally {
        readline.close();
    }
};

const checkComplete = async (file, start, header) => {
    if (file.endsWith('.part')) throw new SyncError(`${shownPath(file)} is an unfinished file. Nothing was changed.`);

    const end = await readDumpEnd(file);

    if (header.prefix && !end.trimEnd().endsWith(DUMP_END)) {
        throw new SyncError(`${shownPath(file)} is incomplete: its end marker is missing. Nothing was changed.`);
    }

    if (!header.prefix && /^-- (MySQL|MariaDB) dump/m.test(start) && !/-- Dump completed/.test(end)) {
        throw new SyncError(`${shownPath(file)} is incomplete: mysqldump did not finish it. Nothing was changed.`);
    }

    if (!header.prefix && !/^-- (MySQL|MariaDB) dump/m.test(start)) {
        console.log('Note: this file was not made by these scripts or mysqldump, so it cannot be checked for completeness.');
    }
};

const restore = async () => {
    const config = readLocalConfig(configName);

    // npm runs scripts in the theme folder; INIT_CWD is the folder the command was typed in.
    const file = fileArg
        ? path.resolve(process.env.INIT_CWD || process.cwd(), fileArg)
        : newestBackup(localBackupDir(), ['backup-before-pull', 'backup-before-restore'], '.sql')?.file;

    if (!file) throw new SyncError(`there are no backups in ${shownPath(localBackupDir())} yet. Name the file: npm run restore -- <file.sql>`);
    if (!existsSync(file)) throw new SyncError(`${file} not found.`);

    const prefix = localPrefix();
    const start = readDumpStart(file);
    const header = readDumpHeader(start);

    if (header.prefix && header.prefix !== prefix) {
        throw new SyncError(`the backup has the table prefix "${header.prefix}", the local site uses "${prefix}". Nothing was changed.`);
    }

    await checkComplete(file, start, header);

    local = await openLocalDatabase(config, { legacy: legacyDb });

    const target = await localUrls(local, prefix).catch(() => null);
    const pairs = header.home && target?.fromOptions ? replacePairs(header, target) : [];
    const safety = path.join(localBackupDir(), `backup-before-restore-${stamp()}.sql`);

    console.log('Restore');
    console.log(`  backup: ${shownPath(file)}${fileArg ? '' : ' (the newest one)'}`);
    console.log(`  into: ${local.database} (${local.label})`);
    if (pairs.length) console.log(`  the backup comes from ${header.home}: its URLs become ${target.home}`);
    if (header.home && !target?.fromOptions) console.log(`  the local site address is not in the database, so the backup's URLs stay as they are (${header.home}).`);
    console.log(`  the current state is saved first: ${shownPath(safety)}`);

    if (dryRun) {
        console.log('\nDry run: nothing was changed.');
        return;
    }

    await confirm(local.database);
    timer.lap('waiting for your confirmation');

    mkdirSync(localBackupDir(), { recursive: true });
    console.log('  saving the current state …');
    await local.backup(safety, prefix);
    timer.lap('current state saved');

    console.log('  importing the backup …');

    const undoHint = `The local database may be incomplete. The state before this restore is back with:\n  npm run restore -- "${safety}"`;
    const onCtrlC = () => {
        console.error(`\n\nRestore interrupted during the import. ${undoHint}`);
        process.exit(130);
    };

    process.once('SIGINT', onCtrlC);

    try {
        await local.importDump(file);
        timer.lap('import');

        if (pairs.length) {
            console.log(`  replacing ${header.home} → ${target.home} …`);
            Object.entries(await local.replaceUrls(prefix, pairs)).forEach(([table, count]) => console.log(`    ${table}: ${count}`));
            timer.lap('URLs');
        }
    } catch (error) {
        throw new SyncError(`${error.message}\n${undoHint}`);
    } finally {
        process.off('SIGINT', onCtrlC);
    }

    reportPrunedBackups(config);
    console.log('\nRestore finished. Tables the backup does not contain were left as they are.');
};

try {
    await restore();
} catch (error) {
    console.error(`\nRestore stopped: ${error instanceof SyncError ? error.message : error.stack || error}`);
    process.exitCode = 1;
} finally {
    await local?.close();
    console.log(timer.summary());
}
