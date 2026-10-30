import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DUMPER, DUMP_END, PHP_COMMON, PHP_WALKER, SyncError, siteDir } from './sync.mjs';

const REPLACER = String.raw`<?php
` + PHP_COMMON + PHP_WALKER + String.raw`
[$db, $prefix, $job] = sync_connect();
echo json_encode(sr_replace_tables($db, $job['start'], $job['pairs']));
`;

const findLocalSite = () => {
    const sitesFile = path.join(process.env.APPDATA || '', 'Local', 'sites.json');

    if (process.platform !== 'win32' || !existsSync(sitesFile)) throw new SyncError('--legacy-db works only with Local on Windows: sites.json not found.');

    const site = Object.values(JSON.parse(readFileSync(sitesFile, 'utf8')))
        .find((item) => path.resolve(item.path.replace(/^~/, os.homedir())).toLowerCase() === siteDir.toLowerCase());

    if (!site) throw new SyncError(`no Local site found for ${siteDir}.`);

    const services = path.join(process.env.APPDATA, 'Local', 'lightning-services');
    const findBinary = (service, relative) => {
        const prefix = `${service.name}-${service.version}`;
        const dir = readdirSync(services)
            .filter((name) => name === prefix || name.startsWith(`${prefix}+`))
            .sort()
            .reverse()
            .find((name) => existsSync(path.join(services, name, relative)));

        if (!dir) throw new SyncError(`${relative} for ${prefix} not found in Local.`);

        return path.join(services, dir, relative);
    };

    const mysqlBin = path.dirname(findBinary(site.services.mysql, 'bin/win64/bin/mysql.exe'));
    const php = findBinary(site.services.php, 'bin/win64/php.exe');

    return {
        domain: site.domain,
        database: site.mysql?.database || 'local',
        user: site.mysql?.user || 'root',
        password: site.mysql?.password || 'root',
        port: site.services.mysql.ports.MYSQL[0],
        mysql: path.join(mysqlBin, 'mysql.exe'),
        mysqldump: path.join(mysqlBin, 'mysqldump.exe'),
        php,
        phpExt: path.join(path.dirname(php), 'ext'),
    };
};

const mysqlArgs = (local) => ['-h127.0.0.1', `-P${local.port}`, `-u${local.user}`, `--password=${local.password}`, '--default-character-set=utf8mb4'];

const query = (local, sql) => {
    const result = spawnSync(local.mysql, [...mysqlArgs(local), '-N', '-B', '-e', sql, local.database], { encoding: 'utf8' });

    if (result.status !== 0) throw new SyncError(`MySQL query failed: ${result.stderr.trim()}`);

    return result.stdout.split(/\r?\n/).filter(Boolean);
};

const runToFile = (command, commandArgs, file) => new Promise((resolve, reject) => {
    const out = openSync(file, 'w');
    const child = spawn(command, commandArgs, { stdio: ['ignore', out, 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
        closeSync(out);
        code === 0 ? resolve() : reject(new SyncError(stderr.trim() || `${path.basename(command)} exited with ${code}`));
    });
});

const runFromFile = (command, commandArgs, file) => new Promise((resolve, reject) => {
    const input = openSync(file, 'r');
    const child = spawn(command, commandArgs, { stdio: [input, 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
        closeSync(input);
        code === 0 ? resolve() : reject(new SyncError(stderr.trim() || `${path.basename(command)} exited with ${code}`));
    });
});

const phpArgs = (local, script, job) => [
    '-n',
    '-d', `extension_dir=${local.phpExt}`,
    '-d', 'extension=mysqli',
    '-d', 'extension=mbstring',
    '-d', 'extension=openssl',
    '-d', 'memory_limit=1024M',
    script,
    job,
];

const withLocalPhp = async (local, source, job, run) => {
    const id = randomBytes(6).toString('hex');
    const script = path.join(os.tmpdir(), `sync-${id}.php`);
    const jobFile = path.join(os.tmpdir(), `sync-${id}.json`);

    writeFileSync(script, source);
    writeFileSync(jobFile, JSON.stringify({
        host: '127.0.0.1',
        port: local.port,
        user: local.user,
        password: local.password,
        database: local.database,
        ...job,
    }));

    try {
        return await run(local.php, phpArgs(local, script, jobFile));
    } finally {
        unlinkSync(script);
        unlinkSync(jobFile);
    }
};

const replaceLocalUrls = (local, start, pairs) => withLocalPhp(local, REPLACER, { prefix: start, start, pairs }, (php, args) => {
    const result = spawnSync(php, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

    if (result.status !== 0) throw new SyncError(`URL replacement failed: ${(result.stdout + result.stderr).trim()}`);

    return JSON.parse(result.stdout);
});

const dumpLocal = (local, prefix, file, rename = '') => withLocalPhp(
    local,
    DUMPER.replace('__END__', DUMP_END),
    { prefix, rename },
    (php, args) => runToFile(php, args, file),
);

export const openLegacyDatabase = async () => {
    const local = findLocalSite();

    try {
        query(local, 'SELECT 1');
    } catch (error) {
        throw new SyncError(`cannot reach the Local database. Is the site running in Local? (${error.message})`);
    }

    return {
        label: `Local, port ${local.port}, --legacy-db`,
        database: local.database,
        domain: local.domain,
        query: async (sql) => query(local, sql).map((line) => line.split('\t')),
        backup: (file) => runToFile(local.mysqldump, [...mysqlArgs(local), '--single-transaction', '--routines', '--hex-blob', local.database], file),
        importDump: (file) => runFromFile(local.mysql, [...mysqlArgs(local), local.database], file),
        replaceUrls: (start, pairs) => replaceLocalUrls(local, start, pairs),
        dump: (prefix, file, rename) => dumpLocal(local, prefix, file, rename),
        close: async () => {},
    };
};
