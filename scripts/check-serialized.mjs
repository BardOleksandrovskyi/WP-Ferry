// Compares the two copies of the URL replacement: PHP_WALKER (sync.mjs, used on the server) and serialized.mjs (used locally by pull).
// Usage: npm run check:serialized -- [--seed=N] [--count=N] [--show=N]. Needs PHP: the PHP environment variable, php in PATH or Local's PHP.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceSerialized } from './serialized.mjs';
import { PHP_COMMON, PHP_WALKER, replacePairs } from './sync.mjs';

const args = process.argv.slice(2);
const option = (key, fallback) => Number(args.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback);
const seed = option('seed', randomBytes(3).readUIntBE(0, 3));
const count = option('count', 500);
const SERVER = 'https://dev.example.com';
const LOCAL = 'http://example.local';

const findPhp = () => {
    if (process.env.PHP) return process.env.PHP;
    if (spawnSync('php', ['-v']).status === 0) return 'php';

    const roots = [
        path.join(process.env.APPDATA || '', 'Local', 'lightning-services'),
        path.join(os.homedir(), 'Library', 'Application Support', 'Local', 'lightning-services'),
    ];

    for (const root of roots.filter((dir) => existsSync(dir))) {
        const versions = readdirSync(root).filter((dir) => dir.startsWith('php-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

        for (const version of versions) {
            const binary = ['bin/win64/php.exe', 'bin/darwin-arm64/bin/php', 'bin/darwin/bin/php', 'bin/linux/bin/php']
                .map((relative) => path.join(root, version, relative))
                .find((file) => existsSync(file));

            if (binary) return binary;
        }
    }

    return null;
};

const PHP_CASES = String.raw`
$job = json_decode(file_get_contents($argv[1]), true);
$server = $job['server'];
$local = $job['local'];
$pieces = [$server, "$server/path/", str_replace('/', '\/', "$server/x"), 'http://dev.example.com', strtoupper($server), $local, "$local/", 'Привіт', '🙂', 'a"b', 'x;y', '{}', 's:3:"', 'N;', "\0", "\n", ' ', 'plain', '\\'];

function chk_text($pieces)
{
    $out = '';
    for ($i = mt_rand(0, 6); $i > 0; $i--) $out .= $pieces[mt_rand(0, count($pieces) - 1)];

    return $out;
}

function chk_value($depth, $pieces)
{
    switch (mt_rand(0, $depth < 3 ? 10 : 5)) {
        case 0: return null;
        case 1: return (bool) mt_rand(0, 1);
        case 2: return mt_rand(-1000, 1000000);
        case 3: return mt_rand() / 7;
        case 4:
        case 5: return chk_text($pieces);
        case 6:
        case 7:
            $list = [];
            for ($i = mt_rand(0, 4); $i > 0; $i--) {
                if (mt_rand(0, 1)) $list[] = chk_value($depth + 1, $pieces);
                else $list[chk_text($pieces) ?: 'key'] = chk_value($depth + 1, $pieces);
            }
            return $list;
        case 8:
            $object = new stdClass();
            for ($i = mt_rand(0, 3); $i > 0; $i--) $object->{"p$i"} = chk_value($depth + 1, $pieces);
            return $object;
        case 9: return serialize(chk_value($depth + 1, $pieces));
        default: return json_encode(chk_value($depth + 1, $pieces));
    }
}

$object = new stdClass();
$object->url = "$server/page/";
$object->n = 1.5;
$object->z = null;

$cases = [
    serialize(['url' => "$server/x", 'uk' => "Привіт $server/шлях", 'emoji' => "🙂 $server 🙂"]),
    serialize(['nested' => serialize(['a' => $server, 'b' => [1, 2, "$server/deep"]])]),
    serialize($object),
    serialize([1 => $object, 2 => $object]),
    json_encode(['u' => "$server/a/", 'list' => ["$server/1", 'x']]),
    json_encode(['u' => "$server/юнікод/"], JSON_UNESCAPED_UNICODE),
    's:5:"' . $server . '";',
    'a:1:{s:3:"url";s:999:"' . $server . '";}',
    'C:11:"ArrayObject":21:{x:i:0;a:0:{};m:a:0:{}}',
    "Plain text $server and http://dev.example.com and " . strtoupper($server),
    serialize(['b' => false, 'i' => -7, 'd' => 0.1, 'n' => null, 's' => '']),
    'a:1:{i:0;s:23:"' . $server . '";}tail',
    serialize(str_repeat("$server/ ", 2000)),
    "Tab\tquote' dq\" back\\slash $server nul" . chr(0) . 'end',
    serialize("O:8:\"stdClass\":0:{} inside $server"),
];

mt_srand((int) $job['seed']);

for ($n = 0; $n < (int) $job['count']; $n++) {
    $roll = mt_rand(0, 99);

    if ($roll < 10) {
        $cases[] = chk_text($pieces);
        continue;
    }

    $value = serialize(chk_value(0, $pieces));

    if ($roll < 15) $value = substr($value, 0, mt_rand(0, strlen($value)));
    elseif ($roll < 20) $value = preg_replace_callback('/s:(\d+):/', fn($m) => 's:' . ($m[1] + 1) . ':', $value, 1);
    elseif ($roll < 25) $value .= 'tail';

    $cases[] = $value;
}

function chk_valid($value)
{
    $data = @unserialize($value, ['allowed_classes' => ['stdClass']]);

    return ($data !== false || $value === 'b:0;') && serialize($data) === $value;
}

$results = [];
$broken = [];

foreach ($job['directions'] as $d => $pairs) {
    $from = array_column($pairs, 0);
    $to = array_column($pairs, 1);

    foreach ($cases as $i => $value) {
        $out = sr_value($value, $from, $to);
        $results[$d][$i] = base64_encode($out);

        if (chk_valid($value) && $out !== 'b:0;' && @unserialize($out, ['allowed_classes' => ['stdClass']]) === false) $broken[] = "$d:$i";
    }
}

echo json_encode(['php' => PHP_VERSION, 'cases' => array_map('base64_encode', $cases), 'results' => $results, 'broken' => $broken]);
`;

const php = findPhp();

if (!php) {
    console.error('PHP not found. Set the PHP environment variable to a php executable, e.g. PHP=/usr/bin/php npm run check:serialized');
    process.exit(1);
}

const directions = {
    pull: replacePairs({ home: SERVER, siteurl: SERVER }, { home: LOCAL, siteurl: LOCAL }),
    push: replacePairs({ home: LOCAL, siteurl: LOCAL }, { home: SERVER, siteurl: SERVER }),
};
const id = randomBytes(6).toString('hex');
const script = path.join(os.tmpdir(), `check-serialized-${id}.php`);
const jobFile = path.join(os.tmpdir(), `check-serialized-${id}.json`);

writeFileSync(script, `<?php\n${PHP_COMMON}${PHP_WALKER}${PHP_CASES}`);
writeFileSync(jobFile, JSON.stringify({ server: SERVER, local: LOCAL, seed, count, directions }));

let result;

try {
    const run = spawnSync(php, ['-n', script, jobFile], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

    if (run.status !== 0) throw new Error((run.stdout + run.stderr).trim() || `php exited with ${run.status}`);

    result = JSON.parse(run.stdout);
} finally {
    unlinkSync(script);
    unlinkSync(jobFile);
}

const toBytes = (text) => Buffer.from(text, 'utf8').toString('latin1');
const cases = result.cases.map((value) => Buffer.from(value, 'base64').toString('latin1'));
const differences = [];

for (const [direction, pairs] of Object.entries(directions)) {
    const from = pairs.map(([search]) => toBytes(search));
    const to = pairs.map(([, replacement]) => toBytes(replacement));

    cases.forEach((value, i) => {
        const expected = Buffer.from(result.results[direction][i], 'base64').toString('latin1');
        const actual = replaceSerialized(value, from, to);

        if (actual !== expected) differences.push({ direction, i, value, expected, actual });
    });
}

const preview = (text, length = 160) => JSON.stringify(Buffer.from(text, 'latin1').toString('utf8').slice(0, length));
const show = args.find((arg) => arg.startsWith('--show='))?.slice(7);

if (show !== undefined) {
    console.log(`value #${show}: ${preview(cases[show], Infinity)}`);
    Object.keys(directions).forEach((direction) => console.log(`${direction}: ${preview(Buffer.from(result.results[direction][show], 'base64').toString('latin1'), Infinity)}`));
}

console.log(`PHP ${result.php}, seed ${seed}: ${cases.length} values × ${Object.keys(directions).length} directions`);

if (result.broken.length) {
    console.log(`PHP copy turned valid serialized data into invalid: ${result.broken.length} values`);
    result.broken.slice(0, 5).forEach((key) => {
        const [direction, i] = key.split(':');

        console.log(`\n  ${direction} #${i}\n    value: ${preview(cases[i])}\n    PHP:   ${preview(Buffer.from(result.results[direction][i], 'base64').toString('latin1'))}`);
    });
}

if (differences.length) {
    console.log(`\n${differences.length} differences between the PHP and JavaScript copies:`);
    differences.slice(0, 5).forEach(({ direction, i, value, expected, actual }) => {
        console.log(`\n  ${direction} #${i}\n    value: ${preview(value)}\n    PHP:   ${preview(expected)}\n    JS:    ${preview(actual)}`);
    });
    console.log(`\nRepeat with: npm run check:serialized -- --seed=${seed} --count=${count}`);
}

if (differences.length || result.broken.length) {
    process.exitCode = 1;
} else {
    console.log('The PHP and JavaScript copies give identical results.');
}
