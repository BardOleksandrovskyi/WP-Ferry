import {
    closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
    constants as zlibConstants, createGunzip, createGzip, gunzipSync,
} from 'node:zlib';
import mysql from 'mysql2/promise';
import { openLegacyDatabase } from './legacy-db.mjs';
import { replaceSerialized } from './serialized.mjs';
import { DUMP_END, SyncError, findLocalSite, readWpConfig } from './sync.mjs';
import { phpDefine } from './wp-config.mjs';

const MAMP_SOCKET = '/Applications/MAMP/tmp/mysql/mysql.sock';
// mysql2 adds IGNORE_SPACE (changes sql_mode) and LOCAL_FILES by default; mysql.exe and PHP do neither.
const FLAGS = ['-IGNORE_SPACE', '-LOCAL_FILES'];
// BIT and GEOMETRY too: written as raw bytes they cannot be read back.
const BINARY_TYPES = new Set([16, 249, 250, 251, 252, 253, 254, 255]);
const BATCH_SIZE = 500000;
const ESCAPES = { '\0': '\\0', '\n': '\\n', '\r': '\\r', '\\': '\\\\', "'": "\\'", '"': '\\"', '\x1a': '\\Z' };

const name = (value) => `\`${value.replaceAll('`', '``')}\``;
const bytes = (text) => Buffer.from(text, 'utf8').toString('latin1');

export const localPhpVersion = () => findLocalSite()?.phpVersion || null;

const hostCandidates = (host) => {
    const [, hostName, rest] = host.match(/^([^:]*):(.*)$/) || [null, host, ''];
    const tcpHost = !hostName || hostName === 'localhost' ? '127.0.0.1' : hostName;

    if (/^\d+$/.test(rest)) return [{ host: tcpHost, port: Number(rest) }];
    if (rest) return [{ socketPath: rest }];
    if (tcpHost !== '127.0.0.1') return [{ host: tcpHost, port: 3306 }];

    return [
        { host: tcpHost, port: 3306 },
        ...(existsSync(MAMP_SOCKET) ? [{ socketPath: MAMP_SOCKET }] : []),
        { host: tcpHost, port: 8889 },
    ];
};

const describeCandidate = (candidate) => (candidate.socketPath ? `socket ${candidate.socketPath}` : `${candidate.host}:${candidate.port}`);

const locateDatabase = (config) => {
    const override = config.localDb || {};
    const site = findLocalSite();
    let found;

    if (site) {
        found = {
            source: 'Local',
            credentials: { database: site.database, user: site.user, password: site.password },
            candidates: [{ host: '127.0.0.1', port: site.port }],
            domain: site.domain,
        };
    } else {
        const wpConfig = readWpConfig();

        found = {
            source: 'wp-config.php',
            credentials: { database: phpDefine(wpConfig, 'DB_NAME'), user: phpDefine(wpConfig, 'DB_USER'), password: phpDefine(wpConfig, 'DB_PASSWORD') ?? '' },
            candidates: hostCandidates(phpDefine(wpConfig, 'DB_HOST') || 'localhost'),
            domain: null,
        };
    }

    ['database', 'user', 'password'].forEach((key) => {
        if (override[key] !== undefined) found.credentials[key] = override[key];
    });

    if (override.socket || override.host || override.port) {
        found.source = `localDb in ${config.configName}`;
        found.candidates = [override.socket ? { socketPath: override.socket } : { host: override.host || '127.0.0.1', port: Number(override.port) || 3306 }];
    }

    if (!found.credentials.database || !found.credentials.user) {
        throw new SyncError(`the local database name or user is unknown. Set localDb in ${config.configName}.`);
    }

    return found;
};

// end() waits for unfinished results; after a failed dump destroy() is the way out.
const closeConnection = async (connection) => {
    const ended = connection.end().then(() => true, () => false);
    const timeout = new Promise((resolve) => {
        setTimeout(resolve, 3000, false).unref();
    });

    if (!(await Promise.race([ended, timeout]))) connection.destroy();
};

const connectFirst = async ({ source, credentials, candidates }, configName) => {
    const failures = [];

    for (const candidate of candidates) {
        let connection = null;

        try {
            connection = await mysql.createConnection({
                ...candidate,
                ...credentials,
                charset: 'UTF8MB4_UNICODE_CI',
                flags: FLAGS,
                connectTimeout: 5000,
                disableEval: true,
            });
            connection.connection.on('error', () => {});
            await connection.query('SET NAMES utf8mb4');

            return { connection, candidate };
        } catch (error) {
            if (connection) connection.destroy();
            failures.push(`  ${describeCandidate(candidate)}: ${error.message}`);
        }
    }

    throw new SyncError([
        `cannot reach the local database (found through ${source}). Is the local site running?`,
        ...failures,
        `If the database is elsewhere, set localDb in ${configName}.`,
    ].join('\n'));
};

const escapeValue = (value) => value.replace(/[\0\n\r\\'"\x1a]/g, (char) => ESCAPES[char]);

const readHead = (file, length) => {
    const handle = openSync(file, 'r');
    const head = Buffer.alloc(length);

    try {
        return head.subarray(0, readSync(handle, head, 0, length, 0));
    } finally {
        closeSync(handle);
    }
};

const isGzip = (head) => head[0] === 0x1f && head[1] === 0x8b;

const openDump = (file) => {
    const source = createReadStream(file);

    if (!isGzip(readHead(file, 2))) return source;

    const gunzip = createGunzip();

    source.on('error', (error) => gunzip.destroy(error));

    return source.pipe(gunzip);
};

// Only the start of the file: a cut gzip stream is unpacked as far as it goes (Z_SYNC_FLUSH).
export const readDumpStart = (file) => {
    const head = readHead(file, 65536);

    if (!isGzip(head)) return head.toString('utf8');

    try {
        return gunzipSync(head, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8');
    } catch (error) {
        throw new SyncError(`${file} looks like a .gz file but cannot be unpacked (${error.message}).`);
    }
};

export const readDumpEnd = async (file, length = 4096) => {
    if (!isGzip(readHead(file, 2))) {
        const size = statSync(file).size;
        const handle = openSync(file, 'r');
        const tail = Buffer.alloc(Math.min(length, size));

        try {
            readSync(handle, tail, 0, tail.length, size - tail.length);
        } finally {
            closeSync(handle);
        }

        return tail.toString('utf8');
    }

    let tail = Buffer.alloc(0);

    try {
        for await (const chunk of openDump(file)) tail = Buffer.concat([tail, chunk]).subarray(-length);
    } catch (error) {
        throw new SyncError(`${file} cannot be unpacked to the end (${error.message}): the file is cut or damaged.`);
    }

    return tail.toString('utf8');
};

// Statements end with ";\n" (our dumps) or ";\r\n" (mysqldump on Windows).
async function* readStatements(file) {
    let rest = Buffer.alloc(0);

    for await (const chunk of openDump(file)) {
        const buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let start = 0;

        for (let newline = buffer.indexOf(10, rest.length); newline !== -1; newline = buffer.indexOf(10, newline + 1)) {
            const end = buffer[newline - 1] === 13 ? newline - 1 : newline;

            if (end > start && buffer[end - 1] === 59) {
                yield buffer.subarray(start, end - 1);
                start = newline + 1;
            }
        }

        rest = buffer.subarray(start);
    }

    if (rest.length) yield rest;
}

const openNodeDatabase = async (config) => {
    const found = locateDatabase(config);
    const { connection, candidate } = await connectFirst(found, config.configName);
    const decoder = new TextDecoder('utf-8', { fatal: true });

    const rows = async (sql, values) => (await connection.query({ sql, values, rowsAsArray: true, typeCast: (field) => field.string() }))[0];
    const rawRows = async (sql, values) => (await connection.query({ sql, values, rowsAsArray: true, typeCast: (field) => field.buffer() }))[0];
    const lowerCaseNames = Number((await rows('SELECT @@lower_case_table_names'))[0][0]) > 0;
    const startsWith = (table, start) => (lowerCaseNames ? table.toLowerCase().startsWith(start.toLowerCase()) : table.startsWith(start));

    const tables = async (start) => (await rows('SHOW FULL TABLES'))
        .filter(([table, type]) => type === 'BASE TABLE' && startsWith(table, start))
        .map(([table]) => table);

    // MySQL on Windows keeps table names in lower case: a Linux server needs the original case (wp_wfConfig, an upper-case prefix).
    const serverName = (table, prefix, serverTables) => {
        if (!lowerCaseNames) return table;

        const known = serverTables.find((candidate) => candidate.toLowerCase() === table.toLowerCase());

        return known ?? (startsWith(table, prefix) ? prefix + table.slice(prefix.length) : table);
    };

    async function* dumpChunks({ prefix, start, rename, serverTables }) {
        const chunk = (text) => Buffer.from(text, 'latin1');
        const urls = {};
        const options = await rawRows(`SELECT option_name, option_value FROM ${name(`${prefix}options`)} WHERE option_name IN ('home', 'siteurl')`).catch(() => []);

        for (const [key, value] of options) urls[key.toString('latin1')] = value?.toString('latin1') ?? '';

        yield chunk(`-- prefix: ${bytes(prefix)}\n-- home: ${urls.home ?? ''}\n-- siteurl: ${urls.siteurl ?? ''}\n`);
        yield chunk("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n");

        for (const table of await tables(start)) {
            const sourceName = bytes(name(table));
            const targetName = bytes(name(rename + (serverTables ? serverName(table, prefix, serverTables) : table)));
            let create = (await rawRows(`SHOW CREATE TABLE ${name(table)}`))[0][1].toString('latin1');

            if (targetName !== sourceName) create = `CREATE TABLE ${targetName}${create.slice('CREATE TABLE '.length + sourceName.length)}`;

            yield chunk(`\nDROP TABLE IF EXISTS ${targetName};\n${create};\n`);

            const [, fields] = await connection.query(`SELECT * FROM ${name(table)} LIMIT 0`);
            const binary = fields.map((field) => field.characterSet === 63 && BINARY_TYPES.has(field.columnType));
            const stream = connection.connection.query({ sql: `SELECT * FROM ${name(table)}`, rowsAsArray: true, typeCast: (field) => field.buffer() }).stream();
            let batch = [];
            let size = 0;

            for await (const row of stream) {
                const line = `(${row.map((value, i) => {
                    if (value === null) return 'NULL';
                    if (binary[i]) return value.length ? `0x${value.toString('hex')}` : "''";

                    return `'${escapeValue(value.toString('latin1'))}'`;
                }).join(',')})`;

                batch.push(line);
                size += line.length;

                if (size > BATCH_SIZE) {
                    yield chunk(`INSERT INTO ${targetName} VALUES ${batch.join(',\n')};\n`);
                    batch = [];
                    size = 0;
                }
            }

            if (batch.length) yield chunk(`INSERT INTO ${targetName} VALUES ${batch.join(',\n')};\n`);
        }

        yield chunk(`\nSET FOREIGN_KEY_CHECKS=1;\nSET UNIQUE_CHECKS=1;\n${DUMP_END}\n`);
    }

    // One consistent snapshot like mysqldump --single-transaction; the file gets its name only when complete.
    const writeDump = async ({ prefix, start, rename = '', serverTables = null, file, gzip }) => {
        const partFile = `${file}.part`;

        await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');

        try {
            await pipeline(Readable.from(dumpChunks({ prefix, start, rename, serverTables })), ...(gzip ? [createGzip()] : []), createWriteStream(partFile));
        } catch (error) {
            connection.destroy();
            if (existsSync(partFile)) unlinkSync(partFile);
            throw new SyncError(`the local database dump failed, nothing was changed: ${error.message}`);
        }

        await connection.query('COMMIT');
        renameSync(partFile, file);
    };

    return {
        label: found.source === 'Local' ? `Local, port ${candidate.port}` : `${found.source}, ${describeCandidate(candidate)}`,
        database: found.credentials.database,
        domain: found.domain,

        query: rows,

        backup: (file, prefix) => writeDump({ prefix, start: '', file, gzip: false }),

        dump: (prefix, file, rename, serverTables = []) => writeDump({ prefix, start: prefix, rename, serverTables, file, gzip: true }),

        importDump: async (file) => {
            // Sends the dump bytes as they are, like mysql.exe: BINARY leaves them unconverted, and without SESSION_TRACK mysql2 does not switch to UTF-8 after the dump's SET NAMES.
            const importer = await mysql.createConnection({
                ...candidate,
                ...found.credentials,
                charset: 'BINARY',
                flags: [...FLAGS, '-SESSION_TRACK'],
                connectTimeout: 5000,
                disableEval: true,
            });
            let count = 0;

            importer.connection.on('error', () => {});

            try {
                await importer.query('SET NAMES utf8mb4');

                for await (const chunk of readStatements(file)) {
                    const statement = chunk.toString('latin1').replace(/^(?:\s*--[^\n]*\n)*\s*/, '');

                    if (statement === '') continue;

                    try {
                        await importer.query(statement);
                    } catch (error) {
                        throw new SyncError(`import stopped at statement ${count + 1} (${Buffer.from(statement.slice(0, 80), 'latin1').toString('utf8')}…): ${error.message}`);
                    }

                    count += 1;
                }
            } finally {
                await closeConnection(importer);
            }
        },

        replaceUrls: async (start, pairs) => {
            const from = pairs.map(([search]) => bytes(search));
            const to = pairs.map(([, replacement]) => bytes(replacement));
            const report = {};

            if (!from.length) return report;

            for (const table of await tables(start)) {
                const columns = await rows(`SHOW COLUMNS FROM ${name(table)}`);
                const keys = columns.filter((column) => column[3] === 'PRI').map(([field]) => field);
                const texts = columns.filter((column) => /char|text/i.test(column[1])).map(([field]) => field);
                // A binary key is compared as bytes: as text it would not match its row.
                const binaryKeys = new Set(columns.filter((column) => /binary|blob/i.test(column[1])).map(([field]) => field));

                if (!keys.length) {
                    report[table] = 'skipped: no primary key';
                    continue;
                }

                let changed = 0;

                for (const column of texts) {
                    const select = [...new Set([...keys, column])];
                    const where = keys.map((key) => `${name(key)} = ?`).join(' AND ');
                    const matches = await rawRows(
                        `SELECT ${select.map(name).join(', ')} FROM ${name(table)} WHERE ${pairs.map(() => `${name(column)} LIKE ?`).join(' OR ')}`,
                        pairs.map(([search]) => `%${search.replace(/[%_\\]/g, '\\$&')}%`),
                    );

                    for (const row of matches) {
                        const value = row[select.indexOf(column)].toString('latin1');
                        const next = Buffer.from(replaceSerialized(value, from, to), 'latin1');
                        let text;

                        if (next.toString('latin1') === value) continue;

                        // Sent as text: as bytes the value would not be converted to the column charset (latin1 tables).
                        try {
                            text = decoder.decode(next);
                        } catch {
                            text = next;
                        }

                        await connection.query(
                            `UPDATE ${name(table)} SET ${name(column)} = ? WHERE ${where}`,
                            [text, ...keys.map((key) => (binaryKeys.has(key) ? row[select.indexOf(key)] : row[select.indexOf(key)].toString('utf8')))],
                        );
                        changed += 1;
                    }
                }

                if (changed) report[table] = changed;
            }

            return report;
        },

        close: () => closeConnection(connection),
    };
};

export const openLocalDatabase = (config, { legacy = false } = {}) => (legacy ? openLegacyDatabase() : openNodeDatabase(config));

export const localUrls = async (db, prefix) => {
    let options;

    try {
        options = new Map(await db.query(`SELECT option_name, option_value FROM ${prefix}options WHERE option_name IN ('home', 'siteurl')`));
    } catch (error) {
        // Only a missing table (1146) falls back; any other error is real.
        if (error?.errno !== 1146 && !/\b1146\b|doesn't exist/.test(error?.message || '')) {
            throw new SyncError(`cannot read the local site address from ${prefix}options: ${error.message}`);
        }

        // No options table yet (a fresh site or an interrupted import): the address comes from Local or WP_HOME.
        const wpConfig = readWpConfig();
        const home = (db.domain ? `http://${db.domain}` : null) || phpDefine(wpConfig, 'WP_HOME');

        if (!home) {
            throw new SyncError([
                `cannot read the local site address: ${prefix}options cannot be read (${error.message}).`,
                "  A fresh local site: add define('WP_HOME', 'http://your-local-address'); to wp-config.php, then run this again.",
                '  An interrupted import: put the last backup back with npm run restore (it takes the newest backup in local/).',
            ].join('\n'));
        }

        return { home, siteurl: phpDefine(wpConfig, 'WP_SITEURL') || home, fromOptions: false };
    }

    const home = options.get('home') || (db.domain ? `http://${db.domain}` : '');

    if (!home) throw new SyncError(`the local database has no home URL in ${prefix}options.`);

    return { home, siteurl: options.get('siteurl') || home, fromOptions: Boolean(options.get('home')) };
};
