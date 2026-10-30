// Plugins part of pull.mjs and push.mjs: wp-content/plugins on both sides is compared by file hashes,
// changed files travel in one gzip pack, and on the server each updated plugin folder is swapped in with one rename.
// Local hashes are cached in .deploy/plugin-hashes.json.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PHP_COMMON, SyncError, callServerScript, readScriptResult, snapshotFile, themeDir, wpRoot } from './sync.mjs';

export const pluginsDir = path.join(wpRoot, 'wp-content', 'plugins');

const hashCacheFile = path.join(themeDir, '.deploy', 'plugin-hashes.json');
const PACK_END = '-- pack complete';
const IGNORED_FILES = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

const SCRIPT = String.raw`<?php
` + PHP_COMMON + String.raw`
sync_guard();

header('Cache-Control: no-store');
header('X-Accel-Buffering: no');

function pl_say($line)
{
    echo $line, "\n";
    @flush();
}

function pl_fail($message)
{
    pl_say('ERROR ' . $message);
    exit;
}

function pl_name($name)
{
    if (!is_string($name) || !preg_match('/^[\w-][\w.-]*$/', $name)) throw new RuntimeException("bad plugin name {$name}");

    return $name;
}

function pl_path($path)
{
    $path = (string) $path;
    if ($path === '' || preg_match('#(^|/)\.\.?(/|$)|^/|\\\\|//|\x00#', $path)) throw new RuntimeException("bad file path {$path}");

    return $path;
}

function pl_dir($dir)
{
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) throw new RuntimeException("could not create {$dir}");
}

function pl_rrmdir($dir)
{
    if (is_link($dir) || is_file($dir)) return @unlink($dir);
    if (!is_dir($dir)) return true;

    foreach (scandir($dir) as $name) {
        if ($name !== '.' && $name !== '..') pl_rrmdir("{$dir}/{$name}");
    }

    return @rmdir($dir);
}

function pl_files($dir, $base = '', &$files = [])
{
    foreach (scandir($dir) as $name) {
        if ($name === '.' || $name === '..') continue;

        $full = "{$dir}/{$name}";
        $relative = $base === '' ? $name : "{$base}/{$name}";

        if (is_link($full)) continue;
        if (is_dir($full)) pl_files($full, $relative, $files);
        elseif (!preg_match('/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i', $relative)) $files[$relative] = md5_file($full);
    }

    return $files;
}

function pl_header($dir)
{
    foreach (glob($dir . '/*.php') ?: [] as $file) {
        $head = str_replace("\r", "\n", (string) @file_get_contents($file, false, null, 0, 8192));
        $field = fn($key) => preg_match('/^[ \t\/*#@]*' . $key . ':(.*)$/mi', $head, $m) ? trim(preg_replace('/\s*(?:\*\/|\?>).*/', '', $m[1])) : '';

        if ($field('Plugin Name') !== '') return ['name' => $field('Plugin Name'), 'version' => $field('Version'), 'requiresWp' => $field('Requires at least'), 'requiresPhp' => $field('Requires PHP')];
    }

    return null;
}

$action = (string) ($_POST['action'] ?? '');

try {
    $content = __DIR__ . '/' . pl_path(trim((string) ($_POST['content'] ?? 'wp-content'), '/'));
} catch (Throwable $e) {
    pl_fail($e->getMessage());
}

$root = "{$content}/plugins";

if (!is_dir($root)) pl_fail("{$root} not found on the server");

if ($action === 'list') {
    $plugins = [];

    foreach (scandir($root) as $name) {
        if ($name[0] === '.' || is_link("{$root}/{$name}") || !is_dir("{$root}/{$name}")) continue;

        $plugins[$name] = ['header' => pl_header("{$root}/{$name}"), 'files' => (object) pl_files("{$root}/{$name}")];
    }

    $active = null;

    try {
        [$db, $prefix] = sync_connect();
        $row = $db->query('SELECT option_value FROM ' . sync_name($prefix . 'options') . " WHERE option_name = 'active_plugins'")->fetch_row();
        $active = $row ? array_values((array) @unserialize($row[0], ['allowed_classes' => false])) : [];
    } catch (Throwable $e) {
    }

    $json = json_encode(['plugins' => (object) $plugins, 'active' => $active, 'php' => PHP_VERSION]);

    if ($json === false) pl_fail('the file list could not be encoded: ' . json_last_error_msg());

    header('Content-Type: application/json');
    echo $json;
    exit;
}

if ($action === 'pack') {
    header('Content-Type: application/octet-stream');

    $zip = deflate_init(ZLIB_ENCODING_GZIP);
    $out = function ($data) use ($zip) {
        echo deflate_add($zip, $data, ZLIB_NO_FLUSH);
    };

    try {
        foreach (json_decode((string) ($_POST['files'] ?? ''), true) ?: [] as $plugin => $paths) {
            foreach ($paths as $path) {
                $name = pl_name((string) $plugin) . '/' . pl_path($path);
                $file = "{$root}/{$name}";
                $handle = is_file($file) ? @fopen($file, 'rb') : false;

                if (!$handle) throw new RuntimeException("{$name} could not be read");

                $out("{$name}\t" . filesize($file) . "\t" . md5_file($file) . "\n");
                while (!feof($handle)) $out(fread($handle, 1048576));
                fclose($handle);
            }
        }

        $out("__END__\n");
    } catch (Throwable $e) {
        $out("\nERROR " . $e->getMessage() . "\n");
    }

    echo deflate_add($zip, '', ZLIB_FINISH);
    exit;
}

if ($action !== 'apply') pl_fail('unknown action');

header('Content-Type: text/plain; charset=utf-8');

$pack = __DIR__ . '/__PACK__';
$staging = "{$content}/_sync";
$rollback = "{$content}/_rollback";
$manifest = json_decode((string) ($_POST['manifest'] ?? ''), true);
$remove = json_decode((string) ($_POST['remove'] ?? ''), true);
$gz = null;

if (!is_array($manifest) || !is_array($remove)) {
    @unlink($pack);
    pl_fail('the plugin list did not arrive');
}

try {
    pl_rrmdir($staging);
    pl_dir($staging);

    $gz = @gzopen($pack, 'rb');
    if (!$gz) throw new RuntimeException('the uploaded plugin files were not found');

    $unpacked = 0;

    while (true) {
        $line = gzgets($gz);
        if ($line === false) throw new RuntimeException('the uploaded plugin files are incomplete');

        $line = rtrim($line, "\n");
        if ($line === '__END__') break;

        [$name, $size, $md5] = explode("\t", $line) + ['', '', ''];
        [$plugin, $path] = explode('/', $name, 2) + ['', ''];
        pl_name($plugin);
        pl_path($path);

        if (($manifest[$plugin][$path] ?? null) !== $md5) throw new RuntimeException("{$name} is not in the plugin list");

        $file = "{$staging}/{$name}";
        pl_dir(dirname($file));
        $handle = fopen($file, 'wb');

        for ($left = (int) $size; $left > 0; $left -= strlen($chunk)) {
            $chunk = gzread($gz, min($left, 1048576));
            if ($chunk === false || $chunk === '') throw new RuntimeException('the uploaded plugin files are incomplete');
            fwrite($handle, $chunk);
        }

        fclose($handle);

        if (md5_file($file) !== $md5) throw new RuntimeException("{$name} arrived damaged");

        $unpacked++;
    }

    gzclose($gz);
    $gz = null;
    @unlink($pack);
    pl_say("unpacked {$unpacked} files");

    foreach ($manifest as $plugin => $files) {
        pl_name((string) $plugin);
        pl_dir("{$staging}/{$plugin}");

        foreach ($files as $path => $md5) {
            $path = pl_path($path);
            $target = "{$staging}/{$plugin}/{$path}";

            if (is_file($target)) continue;

            $source = "{$root}/{$plugin}/{$path}";

            if (!is_file($source) || md5_file($source) !== $md5) throw new RuntimeException("{$plugin}/{$path} changed on the server during the push");

            pl_dir(dirname($target));
            if (!@copy($source, $target)) throw new RuntimeException("could not copy {$plugin}/{$path}");
        }

        pl_say("prepared {$plugin}");
    }

    pl_dir($rollback);
    @file_put_contents("{$rollback}/index.php", "<?php\n// Silence is golden.\n");
    @file_put_contents("{$rollback}/.htaccess", "Require all denied\n");
} catch (Throwable $e) {
    if ($gz) gzclose($gz);
    @unlink($pack);
    pl_rrmdir($staging);
    pl_fail($e->getMessage() . '. Nothing was changed on the server.');
}

$done = [];

$retire = function ($plugin) use ($root, $rollback) {
    if (!file_exists("{$root}/{$plugin}")) return false;

    pl_rrmdir("{$rollback}/{$plugin}");
    if (!@rename("{$root}/{$plugin}", "{$rollback}/{$plugin}")) throw new RuntimeException("could not move {$plugin} to _rollback");

    return true;
};

try {
    foreach (array_keys($manifest) as $plugin) {
        $retired = $retire($plugin);

        if (!@rename("{$staging}/{$plugin}", "{$root}/{$plugin}")) {
            if ($retired) @rename("{$rollback}/{$plugin}", "{$root}/{$plugin}");
            throw new RuntimeException("could not put the new {$plugin} in place");
        }

        $done[] = $plugin;
        pl_say("updated {$plugin}");
    }

    foreach ($remove as $plugin) {
        $retire(pl_name($plugin));
        $done[] = $plugin;
        pl_say("removed {$plugin}");
    }
} catch (Throwable $e) {
    pl_rrmdir($staging);
    if (function_exists('opcache_reset')) @opcache_reset();
    pl_fail($e->getMessage() . ($done ? '. Already changed: ' . implode(', ', $done) : '. Nothing was changed on the server.'));
}

pl_rrmdir($staging);
if (function_exists('opcache_reset')) @opcache_reset();

pl_say('DONE ' . json_encode(['changed' => $done]));
`.replaceAll('__END__', PACK_END);

const md5 = (data) => createHash('md5').update(data).digest('hex');

const contentField = (config) => path.posix.relative(config.remoteRoot, config.remoteContent);

const listFiles = (dir, hashFile, base = dir, files = {}) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relative = path.relative(base, full).split(path.sep).join('/');

        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) listFiles(full, hashFile, base, files);
        else if (!IGNORED_FILES.test(relative)) files[relative] = hashFile(full);
    }

    return files;
};

const readHashCache = () => {
    try {
        const cache = JSON.parse(readFileSync(hashCacheFile, 'utf8'));

        return cache.version === 1 && cache.files ? cache.files : {};
    } catch {
        return {};
    }
};

const writeHashCache = (files) => {
    const temp = `${hashCacheFile}.tmp`;

    try {
        mkdirSync(path.dirname(hashCacheFile), { recursive: true });
        writeFileSync(temp, JSON.stringify({ version: 1, files }));
        renameSync(temp, hashCacheFile);
    } catch (error) {
        console.warn(`  Warning: could not save ${path.relative(themeDir, hashCacheFile)} (${error.message}). The next run reads every plugin file again.`);
    }
};

const readHead = (file) => {
    const handle = openSync(file, 'r');
    const buffer = Buffer.alloc(8192);

    try {
        return buffer.toString('utf8', 0, readSync(handle, buffer, 0, buffer.length, 0)).replaceAll('\r', '\n');
    } finally {
        closeSync(handle);
    }
};

const pluginHeader = (dir) => {
    const phpFiles = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.php')).map((entry) => entry.name).sort();

    for (const name of phpFiles) {
        const head = readHead(path.join(dir, name));
        const field = (key) => head.match(new RegExp(`^[ \\t/*#@]*${key}:(.*)$`, 'mi'))?.[1].replace(/\s*(?:\*\/|\?>).*/, '').trim() || '';

        if (field('Plugin Name')) return { name: field('Plugin Name'), version: field('Version'), requiresWp: field('Requires at least'), requiresPhp: field('Requires PHP') };
    }

    return null;
};

export const listLocalPlugins = () => {
    const cached = readHashCache();
    const fresh = {};
    // Files changed in the last 2 s are hashed again next time: their timestamps may not have settled yet.
    const settled = BigInt(Date.now() - 2000);
    const hashFile = (full) => {
        const stat = statSync(full, { bigint: true });
        // ctime is the NTFS change time: copying a file restores mtime, never ctime.
        const key = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
        const relative = path.relative(pluginsDir, full).split(path.sep).join('/');
        const hash = cached[relative]?.[0] === key ? cached[relative][1] : md5(readFileSync(full));

        if (stat.mtimeMs < settled && stat.ctimeMs < settled) fresh[relative] = [key, hash];

        return hash;
    };

    const plugins = Object.fromEntries(readdirSync(pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => [entry.name, { header: pluginHeader(path.join(pluginsDir, entry.name)), files: listFiles(path.join(pluginsDir, entry.name), hashFile) }]));

    writeHashCache(fresh);

    return plugins;
};

export const listServerPlugins = (config) => callServerScript(config, SCRIPT, { action: 'list', content: contentField(config) }, async (response) => {
    const text = await response.text();

    try {
        return JSON.parse(text);
    } catch {
        throw new SyncError(`the server plugin list is broken: ${text.slice(0, 300)}`);
    }
});

export const version = (plugin) => plugin?.header?.version || '?';

export const compareVersions = (a, b) => {
    const x = a.split(/[.+_-]/);
    const y = b.split(/[.+_-]/);

    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        const p = x[i] ?? '0';
        const q = y[i] ?? '0';
        const diff = /^\d+$/.test(p) && /^\d+$/.test(q) ? Number(p) - Number(q) : p.localeCompare(q);

        if (diff) return Math.sign(diff);
    }

    return 0;
};

export const unmetRequirements = (plugins, changes, place, wp, php) => changes.flatMap(({ name }) => {
    const header = plugins[name].header || {};
    const unmet = [];

    if (header.requiresWp && wp && wp !== '?' && compareVersions(wp, header.requiresWp) < 0) unmet.push(`WordPress ${header.requiresWp}+`);
    if (header.requiresPhp && php && compareVersions(php, header.requiresPhp) < 0) unmet.push(`PHP ${header.requiresPhp}+`);

    return unmet.length ? [`${name} ${version(plugins[name])} needs ${unmet.join(' and ')}, ${place} has WordPress ${wp}, PHP ${php || '?'}`] : [];
});

export const diffPlugins = (source, target) => {
    const changes = [];
    let unchanged = 0;

    for (const name of Object.keys(source).sort()) {
        const files = source[name].files;
        const old = target[name]?.files || {};
        const added = Object.keys(files).filter((file) => !(file in old)).sort();
        const changed = Object.keys(files).filter((file) => file in old && old[file] !== files[file]).sort();
        const removed = Object.keys(old).filter((file) => !(file in files)).sort();

        if (target[name] && !added.length && !changed.length && !removed.length) {
            unchanged += 1;
            continue;
        }

        changes.push({ name, isNew: !target[name], from: version(target[name]), to: version(source[name]), added, changed, removed });
    }

    const extra = Object.keys(target).filter((name) => !source[name]).sort().map((name) => ({ name, version: version(target[name]) }));

    return { changes, extra, unchanged };
};

const describeChange = (change) => {
    if (change.isNew) return `+ ${change.name} ${change.to} — new, ${change.added.length} files`;

    const versions = change.from === change.to ? `${change.to} (same version)` : `${change.from} → ${change.to}`;
    const counts = [[change.changed, 'changed'], [change.added, 'added'], [change.removed, 'deleted']]
        .filter(([files]) => files.length)
        .map(([files, label]) => `${files.length} ${label}`);

    return `~ ${change.name} ${versions} — files: ${counts.join(', ')}`;
};

export const printPluginPlan = (plan, extraTitle, extraMark) => {
    console.log(`  unchanged: ${plan.unchanged}`);
    console.log(`\n  To update: ${plan.changes.length}`);
    plan.changes.forEach((change) => console.log(`    ${describeChange(change)}`));

    if (plan.extra.length) {
        console.log(`\n  ${extraTitle}: ${plan.extra.length}`);
        plan.extra.forEach(({ name, version: extraVersion }) => console.log(`    ${extraMark} ${name} ${extraVersion}`));
    }
};

export const pluginSnapshot = (plugins) => Object.fromEntries(Object.keys(plugins).sort().map((name) => [name, {
    version: version(plugins[name]),
    hash: md5(Object.keys(plugins[name].files).sort().map((file) => `${file}\t${plugins[name].files[file]}`).join('\n')),
}]));

export const savePluginsSnapshot = (config, time, plugins) => {
    writeFileSync(snapshotFile(config, time, '.plugins.json'), JSON.stringify(pluginSnapshot(plugins), null, 1));
};

export const uncommittedPlugins = () => {
    const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], { cwd: pluginsDir, encoding: 'utf8' });
    const plugins = new Map();

    if (result.status !== 0) return plugins;

    result.stdout.split('\n').filter(Boolean).forEach((line) => {
        const file = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
        const name = file.match(/wp-content\/plugins\/([^/]+)\//)?.[1];

        if (name) plugins.set(name, [...(plugins.get(name) || []), file]);
    });

    return plugins;
};

const unpack = (data) => {
    const files = new Map();
    let pos = 0;

    while (pos < data.length) {
        const end = data.indexOf(10, pos);

        if (end < 0) break;

        const line = data.toString('utf8', pos, end);

        if (line === PACK_END) return files;
        if (line.startsWith('ERROR ')) throw new SyncError(`the server could not pack the plugins: ${line.slice(6)}`);
        if (line === '') {
            pos = end + 1;
            continue;
        }

        const [name, size, hash] = line.split('\t');
        const body = data.subarray(end + 1, end + 1 + Number(size));

        if (body.length !== Number(size) || md5(body) !== hash) throw new SyncError(`${name} arrived damaged.`);

        files.set(name, body);
        pos = end + 1 + Number(size);
    }

    throw new SyncError('the plugin download is incomplete.');
};

export const downloadPlugins = (config, wanted) => callServerScript(
    config,
    SCRIPT,
    { action: 'pack', content: contentField(config), files: JSON.stringify(wanted) },
    async (response) => {
        let data;

        try {
            data = gunzipSync(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
            throw new SyncError(`the plugin download is broken (${error.message}).`);
        }

        return unpack(data);
    },
);

export const writeLocalPlugins = (changes, files) => {
    files.forEach((body, name) => {
        const target = path.join(pluginsDir, ...name.split('/'));

        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, body);
    });

    const prune = (dir) => {
        readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((entry) => prune(path.join(dir, entry.name)));
        if (!readdirSync(dir).length) rmdirSync(dir);
    };

    changes.forEach((change) => {
        change.removed.forEach((file) => unlinkSync(path.join(pluginsDir, change.name, ...file.split('/'))));

        const dir = path.join(pluginsDir, change.name);

        readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((entry) => prune(path.join(dir, entry.name)));
    });
};

export const removeLocalPlugins = (names) => names.forEach((name) => rmSync(path.join(pluginsDir, name), { recursive: true, force: true }));

export const uploadPlugins = (config, local, changes, remove) => {
    const parts = [];

    for (const change of changes) {
        for (const file of [...change.added, ...change.changed]) {
            const body = readFileSync(path.join(pluginsDir, change.name, ...file.split('/')));

            if (md5(body) !== local[change.name].files[file]) throw new SyncError(`${change.name}/${file} changed during the push. Run it again.`);

            parts.push(Buffer.from(`${change.name}/${file}\t${body.length}\t${local[change.name].files[file]}\n`), body);
        }
    }

    parts.push(Buffer.from(`${PACK_END}\n`));

    const packName = `sync-${randomBytes(16).toString('hex')}.bin`;
    const pack = gzipSync(Buffer.concat(parts));

    console.log(`  uploading ${parts.length > 1 ? (parts.length - 1) / 2 : 0} files (${(pack.length / 1048576).toFixed(1)} MB packed) …`);

    return callServerScript(
        config,
        SCRIPT.replaceAll('__PACK__', packName),
        {
            action: 'apply',
            content: contentField(config),
            manifest: JSON.stringify(Object.fromEntries(changes.map((change) => [change.name, local[change.name].files]))),
            remove: JSON.stringify(remove),
        },
        readScriptResult('the plugin update failed', 'the plugin update did not finish. Check the site and wp-content/_rollback on the server.'),
        [{ name: packName, body: pack }],
    );
};
