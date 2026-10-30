// Shared by pull.mjs, push.mjs, restore-server.mjs and plugins.mjs: server database dumps over FTP + HTTPS, URL replacement on the server, server snapshots.
import { createCipheriv, randomBytes } from 'node:crypto';
import {
    createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { Client } from 'basic-ftp';
import {
    TEST_ENVIRONMENTS, accessOptions, connectionHint, describeEnvironment, readEnvironment,
} from './ftp.mjs';
import { phpTablePrefix } from './wp-config.mjs';

export const themeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const wpRoot = path.resolve(themeDir, '..', '..', '..');
export const siteDir = path.resolve(wpRoot, '..', '..');
export let sqlDir = path.resolve(wpRoot, '..', 'sql');
export const uploadsDir = path.join(wpRoot, 'wp-content', 'uploads');

export const DUMP_END = '-- pull complete';
export const TEMP_TABLES = 'tmppush_';
const OLD_TABLES = 'tmpold_';
export const IGNORED_UPLOADS = /^(\.htaccess$|wpforms\/cache\/|ithemes-security\/)/;
const LIST_LIMIT = 200;

export class SyncError extends Error {}

export const PHP_COMMON = String.raw`
function sync_name($name)
{
    return chr(96) . str_replace(chr(96), chr(96) . chr(96), $name) . chr(96);
}

// Drops comments so a commented-out define() is not read; without the tokenizer extension the source is used as is.
function sync_code($source)
{
    if (!function_exists('token_get_all')) return $source;

    $code = '';

    foreach (token_get_all($source) as $token) {
        if (!is_array($token)) $code .= $token;
        elseif ($token[0] === T_COMMENT || $token[0] === T_DOC_COMMENT) $code .= "\n";
        else $code .= $token[1];
    }

    return $code;
}

function sync_config($source, $name)
{
    $pattern = '/define\s*\(\s*([\'"])' . $name . '\1\s*,\s*([\'"])((?:\\\\.|(?!\2).)*)\2\s*\)/s';
    if (!preg_match($pattern, $source, $m)) return null;

    return $m[2] === "'" ? strtr($m[3], ["\\'" => "'", '\\\\' => '\\']) : stripcslashes($m[3]);
}

function sync_guard()
{
    if (PHP_SAPI === 'cli') return;

    if (!isset($_POST['key']) || !hash_equals('__KEY__', (string) $_POST['key'])) {
        http_response_code(404);
        exit;
    }

    @unlink(__FILE__);
    @set_time_limit(0);
    @ini_set('zlib.output_compression', '0');

    while (ob_get_level()) ob_end_clean();
}

function sync_connect()
{
    global $argv;

    mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

    if (PHP_SAPI === 'cli') {
        $job = json_decode(file_get_contents($argv[1]), true);
        $db = new mysqli($job['host'], $job['user'], $job['password'], $job['database'], (int) $job['port']);
        $db->set_charset('utf8mb4');

        return [$db, $job['prefix'], $job];
    }

    $source = @file_get_contents(__DIR__ . '/wp-config.php');
    if ($source === false) $source = @file_get_contents(dirname(__DIR__) . '/wp-config.php');
    if ($source === false) throw new RuntimeException('wp-config.php not found');

    $source = sync_code($source);
    $prefix = preg_match('/\$table_prefix\s*=\s*([\'"])(.*?)\1\s*;/', $source, $m) ? $m[2] : 'wp_';
    $host = sync_config($source, 'DB_HOST') ?: 'localhost';
    $port = (int) ini_get('mysqli.default_port') ?: 3306;
    $socket = null;

    if (preg_match('/^(.*):(\d+)$/', $host, $m)) {
        $host = $m[1];
        $port = (int) $m[2];
    } elseif (strpos($host, ':') !== false) {
        [$host, $socket] = explode(':', $host, 2);
    }

    $db = new mysqli($host, sync_config($source, 'DB_USER'), sync_config($source, 'DB_PASSWORD'), sync_config($source, 'DB_NAME'), $port, $socket);
    $db->set_charset('utf8mb4');

    return [$db, $prefix, []];
}

function sync_tables($db, $start)
{
    $tables = [];

    foreach ($db->query('SHOW FULL TABLES')->fetch_all() as $row) {
        if ($row[1] === 'BASE TABLE' && strpos($row[0], $start) === 0) $tables[] = $row[0];
    }

    return $tables;
}
`;

// URL replacement that keeps serialized data valid. serialized.mjs is its JavaScript copy (pull uses that one locally):
// change both together and run npm run check:serialized.
export const PHP_WALKER = String.raw`
function sr_value($value, $from, $to)
{
    if (preg_match('/^(?:[aOCsbidrRE]:|N;)/', $value)) {
        try {
            $pos = 0;
            $out = sr_walk($value, $pos, $from, $to);
            if ($pos === strlen($value)) return $out;
        } catch (RuntimeException $e) {
        }
    }

    return str_replace($from, $to, $value);
}

function sr_header($pattern, $s, $p)
{
    if (!preg_match($pattern, $s, $m, 0, $p)) throw new RuntimeException('bad token');

    return $m;
}

// Rewrites string tokens of a serialized value and recalculates their lengths.
function sr_walk($s, &$p, $from, $to)
{
    switch ($s[$p] ?? '') {
        case 'N':
            if (substr($s, $p, 2) !== 'N;') throw new RuntimeException('bad null');
            $p += 2;
            return 'N;';

        case 'b':
        case 'i':
        case 'd':
        case 'r':
        case 'R':
            $m = sr_header('/\G[bidrR]:[^;:{}"]*;/', $s, $p);
            $p += strlen($m[0]);
            return $m[0];

        case 's':
            $m = sr_header('/\Gs:(\d+):"/', $s, $p);
            $start = $p + strlen($m[0]);
            if (substr($s, $start + (int) $m[1], 2) !== '";') throw new RuntimeException('bad string');
            $value = sr_value(substr($s, $start, (int) $m[1]), $from, $to);
            $p = $start + (int) $m[1] + 2;
            return 's:' . strlen($value) . ':"' . $value . '";';

        case 'E':
            $m = sr_header('/\GE:(\d+):"/', $s, $p);
            $end = $p + strlen($m[0]) + (int) $m[1] + 2;
            $token = substr($s, $p, $end - $p);
            $p = $end;
            return $token;

        case 'a':
            $m = sr_header('/\Ga:(\d+):\{/', $s, $p);
            $p += strlen($m[0]);
            return $m[0] . sr_items($s, $p, (int) $m[1], $from, $to);

        case 'O':
        case 'C':
            $m = sr_header('/\G([OC]):(\d+):"/', $s, $p);
            $nameEnd = $p + strlen($m[0]) + (int) $m[2];
            if (substr($s, $nameEnd, 2) !== '":') throw new RuntimeException('bad class');
            $count = sr_header('/\G(\d+):\{/', $s, $nameEnd + 2);
            $head = substr($s, $p, $nameEnd + 2 + strlen($count[0]) - $p);
            $p = $nameEnd + 2 + strlen($count[0]);

            if ($m[1] === 'C') {
                $raw = substr($s, $p, (int) $count[1]);
                $p += (int) $count[1];
                if (($s[$p] ?? '') !== '}') throw new RuntimeException('bad custom object');
                $p++;
                return $head . $raw . '}';
            }

            return $head . sr_items($s, $p, (int) $count[1], $from, $to);
    }

    throw new RuntimeException('unknown token');
}

function sr_items($s, &$p, $count, $from, $to)
{
    $out = '';
    for ($i = 0; $i < $count * 2; $i++) $out .= sr_walk($s, $p, $from, $to);
    if (($s[$p] ?? '') !== '}') throw new RuntimeException('bad list');
    $p++;

    return $out . '}';
}

function sr_replace_tables($db, $start, $pairs)
{
    $from = array_column($pairs, 0);
    $to = array_column($pairs, 1);
    $report = [];

    if (!$from) return $report;

    foreach (sync_tables($db, $start) as $table) {
        $keys = [];
        $columns = [];

        foreach ($db->query('SHOW COLUMNS FROM ' . sync_name($table))->fetch_all(MYSQLI_ASSOC) as $column) {
            if ($column['Key'] === 'PRI') $keys[] = $column['Field'];
            if (preg_match('/char|text/i', $column['Type'])) $columns[] = $column['Field'];
        }

        if (!$keys) {
            $report[$table] = 'skipped: no primary key';
            continue;
        }

        $changed = 0;

        foreach ($columns as $column) {
            $like = implode(' OR ', array_map(
                fn($search) => sync_name($column) . " LIKE '%" . $db->real_escape_string(addcslashes($search, '%_\\')) . "%'",
                $from
            ));
            $select = implode(', ', array_map('sync_name', array_unique(array_merge($keys, [$column]))));

            foreach ($db->query("SELECT {$select} FROM " . sync_name($table) . " WHERE {$like}")->fetch_all(MYSQLI_ASSOC) as $row) {
                $value = sr_value($row[$column], $from, $to);
                if ($value === $row[$column]) continue;

                $where = implode(' AND ', array_map(fn($key) => sync_name($key) . " = '" . $db->real_escape_string($row[$key]) . "'", $keys));
                $db->query('UPDATE ' . sync_name($table) . ' SET ' . sync_name($column) . " = '" . $db->real_escape_string($value) . "' WHERE {$where}");
                $changed++;
            }
        }

        if ($changed) $report[$table] = $changed;
    }

    return $report;
}
`;

// Database dump in a fixed format: one row per line, statements end with ";\n".
// On the server it is a one-time file called over HTTPS; local-db.mjs writes the same format locally.
export const DUMPER = String.raw`<?php
` + PHP_COMMON + String.raw`
sync_guard();

try {
    [$db, $prefix, $job] = sync_connect();
} catch (Throwable $e) {
    http_response_code(500);
    exit('Database connection failed: ' . $e->getMessage());
}

$rename = $job['rename'] ?? '';

header('Content-Type: application/octet-stream');
header('Cache-Control: no-store');
header('X-Accel-Buffering: no');

$zip = deflate_init(ZLIB_ENCODING_GZIP);

function pull_out($text)
{
    global $zip;
    echo deflate_add($zip, $text, ZLIB_NO_FLUSH);
}

$urls = [];
$result = $db->query('SELECT option_name, option_value FROM ' . sync_name($prefix . 'options') . " WHERE option_name IN ('home', 'siteurl')");
while ($row = $result->fetch_row()) $urls[$row[0]] = $row[1];

pull_out("-- prefix: {$prefix}\n-- home: " . ($urls['home'] ?? '') . "\n-- siteurl: " . ($urls['siteurl'] ?? '') . "\n");
pull_out("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n");

// BIT and GEOMETRY too: written as raw bytes they cannot be read back.
$binaryTypes = [MYSQLI_TYPE_BIT, MYSQLI_TYPE_TINY_BLOB, MYSQLI_TYPE_MEDIUM_BLOB, MYSQLI_TYPE_LONG_BLOB, MYSQLI_TYPE_BLOB, MYSQLI_TYPE_STRING, MYSQLI_TYPE_VAR_STRING, MYSQLI_TYPE_GEOMETRY];

foreach (sync_tables($db, $prefix) as $table) {
    $target = $rename . $table;
    $create = $db->query('SHOW CREATE TABLE ' . sync_name($table))->fetch_row()[1];
    if ($rename !== '') $create = substr_replace($create, sync_name($target), strlen('CREATE TABLE '), strlen(sync_name($table)));

    pull_out("\nDROP TABLE IF EXISTS " . sync_name($target) . ";\n{$create};\n");

    $result = $db->query('SELECT * FROM ' . sync_name($table), MYSQLI_USE_RESULT);
    $binary = array_map(fn($field) => $field->charsetnr === 63 && in_array($field->type, $binaryTypes, true), $result->fetch_fields());
    $rows = [];
    $size = 0;

    while ($row = $result->fetch_row()) {
        foreach ($row as $i => $value) {
            if ($value === null) $row[$i] = 'NULL';
            elseif ($binary[$i]) $row[$i] = $value === '' ? "''" : '0x' . bin2hex($value);
            else $row[$i] = "'" . $db->real_escape_string($value) . "'";
        }

        $line = '(' . implode(',', $row) . ')';
        $rows[] = $line;
        $size += strlen($line);

        if ($size > 500000) {
            pull_out('INSERT INTO ' . sync_name($target) . ' VALUES ' . implode(",\n", $rows) . ";\n");
            $rows = [];
            $size = 0;
        }
    }

    if ($rows) pull_out('INSERT INTO ' . sync_name($target) . ' VALUES ' . implode(",\n", $rows) . ";\n");
    $result->free();
}

pull_out("\nSET FOREIGN_KEY_CHECKS=1;\nSET UNIQUE_CHECKS=1;\n__END__\n");
echo deflate_add($zip, '', ZLIB_FINISH);
`;

// Server import: loads the encrypted dump into temporary tables, replaces URLs, then swaps all tables in one RENAME.
export const IMPORTER = String.raw`<?php
` + PHP_COMMON + PHP_WALKER + String.raw`
sync_guard();

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
header('X-Accel-Buffering: no');

function push_say($line)
{
    echo $line, "\n";
    @flush();
}

function push_fail($message)
{
    push_say('ERROR ' . $message);
    exit;
}

$file = __DIR__ . '/__DUMP__';
$data = @file_get_contents($file);
@unlink($file);

if (!function_exists('openssl_decrypt')) push_fail('the PHP openssl extension is missing on the server');
if ($data === false || strlen($data) < 29) push_fail('the uploaded database file was not found');

try {
    [$db, $prefix] = sync_connect();
} catch (Throwable $e) {
    push_fail('database connection failed: ' . $e->getMessage());
}

if ($prefix !== (string) $_POST['prefix']) push_fail("the server table prefix is {$prefix}");

$sql = openssl_decrypt(substr($data, 28), 'aes-256-gcm', hex2bin((string) $_POST['secret']), OPENSSL_RAW_DATA, substr($data, 0, 12), substr($data, 12, 16));
unset($data);

if ($sql === false) push_fail('the uploaded database file could not be decrypted');

$sql = gzdecode($sql);

if ($sql === false || substr(rtrim($sql), -strlen('__END__')) !== '__END__') push_fail('the uploaded database file is incomplete');

$temp = '__TEMP__';
$old = '__OLD__';
$drop = function ($start) use ($db) {
    foreach (sync_tables($db, $start) as $table) $db->query('DROP TABLE ' . sync_name($table));
};

$drop($temp);
$drop($old);

$count = 0;
$pos = 0;
$length = strlen($sql);

while ($pos < $length) {
    $end = strpos($sql, ";\n", $pos);
    if ($end === false) $end = $length;

    $statement = preg_replace('/^(?:\s*--[^\n]*\n)*\s*/', '', substr($sql, $pos, $end - $pos));
    $pos = $end + 2;

    if ($statement === '') continue;

    try {
        $db->query($statement);
    } catch (Throwable $e) {
        $drop($temp);
        push_fail('import stopped, the site still uses the old database: ' . $e->getMessage());
    }

    if (++$count % 50 === 0) push_say("imported {$count} statements");
}

unset($sql);

try {
    $replaced = sr_replace_tables($db, $temp, json_decode((string) $_POST['pairs'], true) ?: []);
} catch (Throwable $e) {
    $drop($temp);
    push_fail('URL replacement failed, the site still uses the old database: ' . $e->getMessage());
}

// Saved errors describe the site the database came from; any of them makes the plugin skip conversions.
try {
    $db->query('DELETE FROM ' . sync_name($temp . $prefix . 'options') . " WHERE option_name = 'webpc_errors_cache'");
} catch (Throwable $e) {
}

$tables = sync_tables($db, $temp);
$existing = array_flip(sync_tables($db, ''));
$renames = [];

if (!$tables) push_fail('nothing was imported');

foreach ($tables as $table) {
    $final = substr($table, strlen($temp));
    if (isset($existing[$final])) $renames[] = sync_name($final) . ' TO ' . sync_name($old . $final);
    $renames[] = sync_name($table) . ' TO ' . sync_name($final);
}

try {
    $db->query('RENAME TABLE ' . implode(', ', $renames));
} catch (Throwable $e) {
    $drop($temp);
    push_fail('switching tables failed, the site still uses the old database: ' . $e->getMessage());
}

$drop($old);

push_say('DONE ' . json_encode(['statements' => $count, 'tables' => count($tables), 'replaced' => $replaced]));
`;

const GENERIC_FOLDERS = new Set(['app', 'htdocs', 'html', 'public', 'public_html', 'web', 'wordpress', 'wp', 'www']);

const siteFolderName = () => {
    let dir = wpRoot;

    while (GENERIC_FOLDERS.has(path.basename(dir).toLowerCase()) && path.dirname(dir) !== dir) dir = path.dirname(dir);

    return path.basename(dir) || 'site';
};

const localSitesFile = () => ({
    win32: path.join(process.env.APPDATA || '', 'Local', 'sites.json'),
    darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Local', 'sites.json'),
    linux: path.join(os.homedir(), '.config', 'Local', 'sites.json'),
})[process.platform];

export const findLocalSite = () => {
    const file = localSitesFile();

    if (!file || !existsSync(file)) return null;

    let sites;

    try {
        sites = Object.values(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
        return null;
    }

    const site = sites.find((item) => typeof item?.path === 'string' && path.resolve(item.path.replace(/^~/, os.homedir())).toLowerCase() === siteDir.toLowerCase());
    const port = site?.services?.mysql?.ports?.MYSQL?.[0];

    if (!port) return null;

    return {
        domain: site.domain,
        phpVersion: site.services?.php?.version || null,
        database: site.mysql?.database || 'local',
        user: site.mysql?.user || 'root',
        password: site.mysql?.password || 'root',
        port,
    };
};

const useBackupDir = (config) => {
    if (config.backupDir) sqlDir = path.resolve(themeDir, config.backupDir);
    else if (!findLocalSite()) sqlDir = path.join(os.homedir(), 'wp-sync-backups', siteFolderName(), path.basename(themeDir));

    moveOldBackups();
};

export const readLocalConfig = (configName) => {
    const configPath = path.resolve(themeDir, configName);
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};

    useBackupDir(config);

    return { ...config, configName };
};

export const readConfig = (configName) => {
    const configPath = path.resolve(themeDir, configName);

    if (!existsSync(configPath)) throw new SyncError(`${configName} not found. Copy deploy.config.example.json and fill it in.`);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const missing = ['host', 'user', 'password', 'remoteDir', 'siteUrl'].filter((key) => !config[key]);

    if (missing.length) throw new SyncError(`${configName} has no ${missing.join(', ')}.`);

    if (!config.siteUrl.toLowerCase().startsWith('https://')) {
        throw new SyncError('siteUrl must start with https:// — the database travels through it.');
    }

    const remoteDir = config.remoteDir.replace(/\/+$/, '');
    const remoteContent = path.posix.dirname(path.posix.dirname(remoteDir));
    const siteUrl = config.siteUrl.replace(/\/+$/, '');

    useBackupDir(config);

    return {
        port: 21,
        secure: false,
        ...config,
        configName,
        siteUrl,
        siteHost: new URL(siteUrl).host,
        remoteContent,
        remoteRoot: path.posix.dirname(remoteContent),
    };
};

export const connect = async (config) => {
    const client = new Client(30000);

    try {
        await client.access(accessOptions(config));
    } catch (error) {
        client.close();
        throw new SyncError(`could not connect to ${config.host}: ${error.message}.${connectionHint(error)}`);
    }

    return client;
};

export const checkTestServer = async (config, command) => {
    const client = await connect(config);
    let environment;

    try {
        environment = await readEnvironment(client, config.remoteRoot);
    } finally {
        client.close();
    }

    if (!TEST_ENVIRONMENTS.includes(environment)) {
        throw new SyncError(`${config.siteHost} is not marked as a test site: ${describeEnvironment(environment)}. ${command} only runs on servers whose wp-config.php sets WP_ENVIRONMENT_TYPE to 'staging' or 'development', so it never overwrites production.`);
    }

    console.log(`Test server: WP_ENVIRONMENT_TYPE is '${environment}'.`);
};

const parseCore = (source) => ({
    wp: source.match(/^\$wp_version = '([^']+)'/m)?.[1] || '?',
    db: Number(source.match(/^\$wp_db_version = (\d+)/m)?.[1] || 0),
});

export const localCore = () => parseCore(readFileSync(path.join(wpRoot, 'wp-includes', 'version.php'), 'utf8'));

export const serverCore = async (config) => {
    const client = await connect(config);
    let source = '';

    try {
        await client.downloadTo(new Writable({
            write(chunk, encoding, done) {
                source += chunk;
                done();
            },
        }), `${config.remoteRoot}/wp-includes/version.php`);
    } catch (error) {
        throw new SyncError(`could not read wp-includes/version.php on the server: ${error.message}`);
    } finally {
        client.close();
    }

    return parseCore(source);
};

export const compareCore = (local, server, toServer, withDb) => {
    const [from, to, place] = toServer ? [local, server, 'the server'] : [server, local, 'the Local site'];

    console.log('\nWordPress');
    console.log(`  local: ${local.wp} (database version ${local.db}), server: ${server.wp} (database version ${server.db})`);

    if (withDb && from.db > to.db) {
        return `the database comes from WordPress ${from.wp}, but ${place} runs older WordPress ${to.wp}: its database update could rewrite the newer tables to the older format. Update WordPress on ${place} first (Dashboard → Updates), then run this again.`;
    }

    if (withDb && from.db < to.db) {
        console.log(`  The database comes from older WordPress ${from.wp}: afterwards open the admin on ${place} and click "Update WordPress Database".`);
    } else if (local.wp !== server.wp) {
        console.log('  The WordPress versions differ, the database format is the same. Update the older one when you can.');
    }

    return null;
};

export const readWpConfig = () => {
    const file = [path.join(wpRoot, 'wp-config.php'), path.join(path.dirname(wpRoot), 'wp-config.php')].find((candidate) => existsSync(candidate));

    if (!file) throw new SyncError(`wp-config.php not found in ${wpRoot} or one level up.`);

    return readFileSync(file, 'utf8');
};

export const localPrefix = () => phpTablePrefix(readWpConfig()) ?? 'wp_';

export const shownPath = (file) => {
    const relative = path.relative(siteDir, file);

    return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
};

export const stamp = () => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');

    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

// Each source URL in both schemes, plain and JSON-escaped, longest first.
export const replacePairs = (source, target) => {
    const pairs = new Map();

    [[source.home, target.home], [source.siteurl, target.siteurl]].forEach(([from, to]) => {
        if (!from || !to || from === to) return;

        const address = from.replace(/^https?:/, '');

        ['http:', 'https:'].forEach((scheme) => {
            pairs.set(scheme + address, to);
            pairs.set((scheme + address).replaceAll('/', '\\/'), to.replaceAll('/', '\\/'));
        });
    });

    return [...pairs].sort((a, b) => b[0].length - a[0].length);
};

// The one-time PHP files delete themselves, so "not found" is the usual answer; false means the file is still there.
const removeUploaded = async (client, file) => {
    try {
        await client.remove(file);
        return true;
    } catch (error) {
        if (typeof error?.code !== 'number') throw error;

        return !(await client.list(path.posix.dirname(file))).some((entry) => entry.name === path.posix.basename(file));
    }
};

// Uploads a one-time PHP file to the WordPress root, calls it with its key and removes it again.
export const callServerScript = async (config, source, fields, handle, extraFiles = []) => {
    const key = randomBytes(24).toString('hex');
    const name = `sync-${randomBytes(16).toString('hex')}.php`;
    const remote = `${config.remoteRoot}/${name}`;
    let client = await connect(config);
    const uploaded = [];

    try {
        const rootEntries = await client.list(config.remoteRoot);

        if (!rootEntries.some((entry) => entry.name === 'wp-load.php')) {
            throw new SyncError(`${config.remoteRoot} does not look like the WordPress root on the server. Check remoteDir.`);
        }

        for (const extra of extraFiles) {
            await client.uploadFrom(Readable.from([extra.body]), `${config.remoteRoot}/${extra.name}`);
            uploaded.push(`${config.remoteRoot}/${extra.name}`);
        }

        await client.uploadFrom(Readable.from([source.replaceAll('__KEY__', key)]), remote);
        uploaded.push(remote);

        const response = await fetch(`${config.siteUrl}/${name}`, {
            method: 'POST',
            body: new URLSearchParams({ key, ...fields }),
            redirect: 'manual',
        });

        if (response.status >= 300 && response.status < 400) {
            throw new SyncError(`${config.siteUrl} redirects to ${response.headers.get('location')}. Put the final address in siteUrl.`);
        }

        if (!response.ok) {
            const text = (await response.text()).slice(0, 300);
            throw new SyncError(`the server answered ${response.status}${text ? `: ${text}` : ''}. Check siteUrl.`);
        }

        return await handle(response);
    } finally {
        for (const file of uploaded) {
            let removed = false;

            try {
                removed = await removeUploaded(client, file);
            } catch {
                // The server may close the connection while it sits idle during a long request.
                try {
                    client.close();
                    client = await connect(config);
                    removed = await removeUploaded(client, file);
                } catch {
                    removed = false;
                }
            }

            if (!removed) console.warn(`\n  Warning: could not remove ${file} from the server. Delete it over FTP by hand.`);
        }

        client.close();
    }
};

export const readScriptResult = (failed, unfinished) => async (response) => {
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;

    const handle = (line) => {
        if (line.startsWith('ERROR ')) throw new SyncError(`${failed}: ${line.slice(6)}`);
        if (line.startsWith('DONE ')) result = JSON.parse(line.slice(5));
        else if (line.trim()) console.log(`    ${line}`);
    };

    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });

        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            handle(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
        }
    }

    handle(buffer);

    if (!result) throw new SyncError(unfinished);

    return result;
};

// Sends a gzipped dump whose tables start with TEMP_TABLES to the importer, encrypted; the key goes separately in the request.
export const importOnServer = async (config, prefix, pairs, body) => {
    const secret = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    const dataName = `sync-${randomBytes(16).toString('hex')}.bin`;
    const importer = IMPORTER
        .replaceAll('__DUMP__', dataName)
        .replaceAll('__TEMP__', TEMP_TABLES)
        .replaceAll('__OLD__', OLD_TABLES)
        .replaceAll('__END__', DUMP_END);

    const result = await callServerScript(
        config,
        importer,
        { secret: secret.toString('hex'), prefix, pairs: JSON.stringify(pairs) },
        readScriptResult('the server import failed', `the server import did not finish. Check the site; the backup is in ${shownPath(serverBackupDir(config))}.`),
        [{ name: dataName, body: Buffer.concat([iv, cipher.getAuthTag(), encrypted]) }],
    );

    console.log(`  imported: ${result.tables} tables`);
    Object.entries(result.replaced || {}).forEach(([table, count]) => console.log(`    URLs in ${table.slice(TEMP_TABLES.length)}: ${count}`));

    return result;
};

// MySQL 8 (utf8mb4_0900_…) and MariaDB 11 (…_uca1400_…) collations are unknown to each other: tables get one both know.
// Only table definitions change, never the data rows (lines starting with INSERT INTO or a row).
// …_ai_ci becomes unicode_520_ci; binary, case- or accent-sensitive ones become _bin, so unique keys stay unique.
export const portableCollations = (sql) => sql.replace(/^(?!INSERT INTO |\().*$/gm, (line) => line.replace(
    /\b(utf8mb[34])_(?:[a-z]{2,3}_)?(?:0900|uca1400)_(\w+)/g,
    (collation, charset, rest) => (/(^|_)ai_ci$/.test(rest) ? `${charset}_unicode_520_ci` : `${charset}_bin`),
));

export const readDumpHeader = (dump) => {
    const header = (field) => dump.match(new RegExp(`^-- ${field}: (.*)$`, 'm'))?.[1].trim() || '';

    return {
        prefix: header('prefix'),
        home: header('home'),
        siteurl: header('siteurl'),
        tables: [...dump.matchAll(/^DROP TABLE IF EXISTS `([^`]+)`;$/gm)].map((match) => match[1]),
    };
};

// Downloads the server database into file; returns its prefix, URLs and tables.
export const downloadDump = async (config, file) => {
    const partFile = `${file}.part`;

    try {
        await callServerScript(config, DUMPER.replace('__END__', DUMP_END), {}, async (response) => {
            try {
                await pipeline(Readable.fromWeb(response.body), createGunzip(), createWriteStream(partFile));
            } catch (error) {
                throw new SyncError(`the database download is broken (${error.message}).`);
            }
        });

        const dump = portableCollations(readFileSync(partFile, 'latin1'));

        if (!dump.trimEnd().endsWith(DUMP_END)) throw new SyncError('the database download is incomplete.');

        writeFileSync(file, dump, 'latin1');

        const header = readDumpHeader(dump);
        const text = (value) => Buffer.from(value, 'latin1').toString('utf8');

        return { prefix: text(header.prefix), home: text(header.home), siteurl: text(header.siteurl), tables: header.tables.map(text) };
    } finally {
        if (existsSync(partFile)) unlinkSync(partFile);
    }
};

// Lists wp-content/uploads with file sizes in one request: over FTP every folder costs a round trip.
const UPLOADS_LISTER = String.raw`<?php
` + PHP_COMMON + String.raw`
sync_guard();

header('Content-Type: application/json');
header('Cache-Control: no-store');

$content = trim((string) ($_POST['content'] ?? 'wp-content'), '/');

if ($content === '' || preg_match('#(^|/)\.\.?(/|$)|\\\\|\x00#', $content)) {
    http_response_code(400);
    exit('bad content path');
}

function up_walk($dir, $base, &$files)
{
    foreach (scandir($dir) ?: [] as $name) {
        if ($name === '.' || $name === '..') continue;

        $full = "{$dir}/{$name}";
        $relative = $base === '' ? $name : "{$base}/{$name}";

        if (is_link($full)) continue;
        if (is_dir($full)) up_walk($full, $relative, $files);
        else $files[$relative] = filesize($full);
    }
}

$files = [];
$root = __DIR__ . "/{$content}/uploads";

if (is_dir($root)) up_walk($root, '', $files);

$json = json_encode((object) $files, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

if ($json === false) {
    http_response_code(500);
    exit('the file list could not be encoded: ' . json_last_error_msg());
}

echo $json;
`;

export const listServerUploads = (config) => callServerScript(
    config,
    UPLOADS_LISTER,
    { content: path.posix.relative(config.remoteRoot, config.remoteContent) },
    async (response) => {
        const text = await response.text();

        try {
            return new Map(Object.entries(JSON.parse(text)));
        } catch {
            throw new SyncError(`the server upload list is broken: ${text.slice(0, 300)}`);
        }
    },
);

export const listLocal = (dir, base = dir, files = new Map()) => {
    if (!existsSync(dir)) return files;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) listLocal(full, base, files);
        else files.set(path.relative(base, full).split(path.sep).join('/'), statSync(full).size);
    }

    return files;
};

export const printList = (title, names, mark) => {
    console.log(`\n  ${title}: ${names.length}`);
    names.slice(0, LIST_LIMIT).forEach((name) => console.log(`    ${mark} ${name}`));
    if (names.length > LIST_LIMIT) console.log(`    … and ${names.length - LIST_LIMIT} more`);
};

// The backups folder holds local/ (the local database before pull and restore) and a folder per server:
// its database before push and restore:server, and snapshot-<stamp>.sql, .uploads.json and .plugins.json, the server as of the last pull, push or restore:server.
const STAMP = String.raw`\d{4}-\d{2}-\d{2}-\d{4,6}`;
const KINDS = new RegExp(String.raw`^(backup-before-pull|backup-before-push|backup-before-restore|snapshot)-(${STAMP})(\.sql|\.uploads\.json|\.plugins\.json)$`);

export const localBackupDir = () => path.join(sqlDir, 'local');

const hostDir = (host) => path.join(sqlDir, host.replaceAll(':', '_'));

export const serverBackupDir = (config) => hostDir(config.siteHost);

export const snapshotFile = (config, time, extension) => path.join(serverBackupDir(config), `snapshot-${time}${extension}`);

// The newest file of the given kinds in dir, with the time from its name.
export const newestBackup = (dir, kinds, extension) => {
    if (!existsSync(dir)) return null;

    const found = readdirSync(dir)
        .map((name) => name.match(KINDS))
        .filter((match) => match && kinds.includes(match[1]) && match[3] === extension)
        .sort((a, b) => a[2].localeCompare(b[2]))
        .pop();

    if (!found) return null;

    const [year, month, day, time] = found[2].split('-');

    return {
        file: path.join(dir, found[0]),
        takenAt: new Date(+year, +month - 1, +day, +time.slice(0, 2), +time.slice(2, 4), +(time.slice(4, 6) || 0)),
    };
};

export const latestSnapshot = (config, extension) => newestBackup(serverBackupDir(config), ['snapshot'], extension);

export const saveUploadsSnapshot = (config, time, files) => {
    writeFileSync(snapshotFile(config, time, '.uploads.json'), JSON.stringify(Object.fromEntries([...files].sort())));
};

// Earlier versions kept every file in the backups folder itself; they move into the new folders once.
const OLD_NAMES = [
    [new RegExp(`^(backup-before-(?:pull|restore)-${STAMP}\\.sql)$`), (match) => [localBackupDir(), match[1]]],
    [new RegExp(`^backup-before-push-(.+)-(${STAMP}\\.sql)$`), (match) => [hostDir(match[1]), `backup-before-push-${match[2]}`]],
    [new RegExp(`^server-(.+)-(${STAMP}(?:\\.sql|\\.uploads\\.json|\\.plugins\\.json))$`), (match) => [hostDir(match[1]), `snapshot-${match[2]}`]],
];

const moveOldBackups = () => {
    if (!existsSync(sqlDir)) return;

    const folders = new Set();
    const failed = [];

    for (const name of readdirSync(sqlDir)) {
        const [pattern, target] = OLD_NAMES.find(([candidate]) => candidate.test(name)) || [];

        if (!pattern) continue;

        const [dir, newName] = target(name.match(pattern));

        if (existsSync(path.join(dir, newName))) continue;

        try {
            mkdirSync(dir, { recursive: true });
            renameSync(path.join(sqlDir, name), path.join(dir, newName));
            folders.add(path.basename(dir));
        } catch (error) {
            failed.push(`${name} (${error.code || error.message})`);
        }
    }

    if (folders.size) console.log(`Backups moved into folders in ${shownPath(sqlDir)}: ${[...folders].join(', ')}.`);
    if (failed.length) console.log(`Could not move into the new folders, left in ${shownPath(sqlDir)}: ${failed.join(', ')}. Close the program that holds them and run the command again.`);
};

const keptBackups = (config) => (Number.isInteger(config.keepBackups) && config.keepBackups >= 0 ? config.keepBackups : 5);

const pruneFolder = (dir, keep) => {
    if (!existsSync(dir)) return 0;

    const kinds = new Map();
    const remove = [];

    for (const name of readdirSync(dir)) {
        if (/^(backup-before-|snapshot-).*\.part$/.test(name)) {
            if (Date.now() - statSync(path.join(dir, name)).mtimeMs > 3600000) remove.push(name);
            continue;
        }

        const match = name.match(KINDS);

        if (!match) continue;

        const kind = match[1] + match[3];

        kinds.set(kind, [...(kinds.get(kind) || []), { name, stamp: match[2] }]);
    }

    for (const files of kinds.values()) {
        remove.push(...files.sort((a, b) => b.stamp.localeCompare(a.stamp)).slice(keep).map(({ name }) => name));
    }

    return remove.filter((name) => {
        try {
            unlinkSync(path.join(dir, name));
            return true;
        } catch {
            return false;
        }
    }).length;
};

// local/ and the folder of the server in the config; folders of other servers are pruned when a command runs against them.
export const pruneBackups = (config) => {
    const keep = keptBackups(config);

    if (!keep) return 0;

    return [localBackupDir(), ...(config.siteHost ? [serverBackupDir(config)] : [])].reduce((sum, dir) => sum + pruneFolder(dir, keep), 0);
};

export const reportPrunedBackups = (config) => {
    const removed = pruneBackups(config);

    if (removed) console.log(`\nOld backups removed: ${removed} (the last ${keptBackups(config)} of each kind are kept).`);
};
