// Deploys the theme over FTP: production build into .deploy/dist, then uploads only the files that changed.
// Usage: npm run deploy -- [--dry-run] [--skip-build] [--force] [--all] [--config=deploy.other.json]
//        npm run deploy:clean -- [--dry-run] [--config=deploy.other.json]  deletes the previous build kept on the server.
// Stops if the server has a deploy from a commit your branch lacks, or files changed outside this script; --force skips the checks, --all uploads every file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from 'basic-ftp';
import {
    TEST_ENVIRONMENTS, accessOptions, connectionHint, describeEnvironment, readEnvironment,
} from './ftp.mjs';
import { createTimer } from './timer.mjs';

const themeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(themeDir, '.deploy', 'dist');

const STATE_FILE = 'deploy-state.php';
const LEGACY_STATE_FILE = 'deploy-state.json';
const STATE_GUARD = '<?php http_response_code(404); exit; ?>\n';
const EXAMPLE_CONFIG = 'deploy.config.example.json';
const CONFIG_FILES = /^deploy\.[^/]+\.json$/;
const BLOCKED_FILES = /(^|\/)(\.env(\..+)?|\.htpasswd|id_(rsa|ecdsa|ed25519)(\.pub)?)$|\.(sql|zip|tar|gz|tgz|7z|rar|bak|log|pem|key|p12|pfx)$/i;
const LAST_FILE = 'dist/webpack-assets.json';
const TEMP_PREFIX = '.deploying-';
const OLD_PREFIX = '.deploy-old-';
const RETRIES = 2;

const args = new Set(process.argv.slice(2));
const configName = [...args].find((arg) => arg.startsWith('--config='))?.slice(9) || 'deploy.config.json';
const configPath = path.resolve(themeDir, configName);
const dryRun = args.has('--dry-run');
const skipBuild = args.has('--skip-build');
const force = args.has('--force');
const uploadAll = args.has('--all');
const clean = args.has('--clean');
const timer = createTimer();

class DeployError extends Error {}

const isServerReply = (error) => typeof error?.code === 'number';

const ignoreServerReply = (error) => {
    if (!isServerReply(error)) throw error;
};

const readConfig = () => {
    if (!existsSync(configPath)) throw new DeployError(`${configName} not found. Copy deploy.config.example.json and fill it in.`);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const missing = ['host', 'user', 'password', 'remoteDir'].filter((key) => !config[key]);

    if (missing.length) throw new DeployError(`${configName} has no ${missing.join(', ')}.`);

    return {
        port: 21,
        secure: false,
        sourceMaps: false,
        ...config,
        remoteDir: config.remoteDir.replace(/\/+$/, ''),
        siteHost: URL.canParse(config.siteUrl || '') ? new URL(config.siteUrl).host : config.host,
    };
};

const cleanCommand = () => {
    if (configName === 'deploy.config.json') return 'npm run deploy:clean';
    if (configName === 'deploy.prod.json') return 'npm run deploy:clean:prod';

    return `npm run deploy:clean -- --config=${configName}`;
};

const build = () => {
    console.log('Building the production bundle into .deploy/dist …');

    const result = spawnSync(process.execPath, [
        path.join(themeDir, 'node_modules', 'webpack', 'bin', 'webpack.js'),
        '--mode=production',
        '--output-path',
        buildDir,
    ], { cwd: themeDir, stdio: 'inherit' });

    if (result.status !== 0) throw new DeployError('the build failed, nothing was uploaded.');
};

const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];

    const full = path.join(dir, entry.name);

    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
});

const isSkipped = (file) => file === STATE_FILE
    || file === LEGACY_STATE_FILE
    || file.startsWith('dist/')
    || (CONFIG_FILES.test(file) && file !== EXAMPLE_CONFIG)
    || path.resolve(themeDir, file) === configPath;

const gitFiles = (...options) => {
    const result = spawnSync('git', ['ls-files', '-z', ...options], {
        cwd: themeDir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.status !== 0) throw new DeployError('could not list the theme files with git. Is git installed and the theme inside a repository?');

    return result.stdout.split('\0').filter((file) => file && !isSkipped(file) && existsSync(path.join(themeDir, file)));
};

const listThemeFiles = () => {
    const untracked = gitFiles('--others', '--exclude-standard');
    const files = [...new Set([...gitFiles('--cached'), ...untracked])];
    const blocked = files.filter((file) => BLOCKED_FILES.test(file));

    if (blocked.length) {
        throw new DeployError([
            'these files must never reach the server (database dumps, archives, logs, backups, keys):',
            ...blocked.map((file) => `  ! ${file}${untracked.includes(file) ? '' : ' (in git)'}`),
            'Move them out of the theme folder or add them to .gitignore.',
            'A file marked "in git" stays in git despite .gitignore: remove it from git first, keeping it on disk: git rm --cached <file>.',
            'Nothing was uploaded.',
        ].join('\n'));
    }

    return { files, untracked };
};

const collectFiles = (config, themeFiles) => {
    const files = new Map();

    themeFiles.forEach((file) => files.set(file, path.join(themeDir, file)));

    if (!existsSync(path.join(buildDir, 'webpack-assets.json'))) throw new DeployError('.deploy/dist has no build. Run without --skip-build.');

    walk(buildDir)
        .filter((file) => config.sourceMaps || !file.endsWith('.map'))
        .forEach((file) => files.set(`dist/${file}`, path.join(buildDir, file)));

    return files;
};

const sha1 = (data) => createHash('sha1').update(data).digest('hex');

const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: themeDir, encoding: 'utf8' });

const gitInfo = () => {
    const head = git('rev-parse', 'HEAD');
    const status = git('status', '--porcelain', '--', '.');

    return {
        commit: head.status === 0 ? head.stdout.trim() : null,
        dirty: status.status === 0 && status.stdout.trim() !== '',
        by: git('config', 'user.name').stdout?.trim() || os.userInfo().username,
    };
};

const hasCommit = (commit) => git('merge-base', '--is-ancestor', commit, 'HEAD').status === 0;

const describeDeploy = (state) => [state.by && `by ${state.by}`, state.deployedAt && `on ${new Date(state.deployedAt).toLocaleString()}`]
    .filter(Boolean)
    .join(' ');

const confirmProduction = async (config, action) => {
    if (!process.stdin.isTTY) throw new DeployError('changes on a production server need confirmation: run this in a terminal.');

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const cancel = new AbortController();

    readline.on('SIGINT', () => cancel.abort());

    try {
        const answer = await readline.question(`\n${action} on ${config.siteHost}, a production server. Type ${config.siteHost} to continue: `, { signal: cancel.signal });

        if (answer.trim() !== config.siteHost) throw new DeployError('not confirmed, nothing was changed.');
    } catch (error) {
        throw error.name === 'AbortError' ? new DeployError('cancelled, nothing was changed.') : error;
    } finally {
        readline.close();
    }
};

const connect = async (config) => {
    const client = new Client(30000);

    try {
        await client.access(accessOptions(config));
    } catch (error) {
        client.close();
        throw new DeployError(`could not connect to ${config.host}: ${error.message}.${connectionHint(error)}`);
    }

    return client;
};

const readState = async (client, remoteFile) => {
    const chunks = [];
    const sink = new Writable({
        write(chunk, encoding, done) {
            chunks.push(chunk);
            done();
        },
    });

    await client.downloadTo(sink, remoteFile);

    const text = Buffer.concat(chunks).toString('utf8');

    try {
        return JSON.parse(text.startsWith('<?php') ? text.slice(text.indexOf('\n') + 1) : text);
    } catch {
        throw new DeployError(`${path.posix.basename(remoteFile)} on the server is damaged, probably cut off by a lost connection. Delete it over FTP: the next deploy then uploads every theme file once.`);
    }
};

const listRemote = async (client, dir, base = dir) => {
    const files = [];

    for (const entry of await client.list(dir)) {
        if (entry.name === '.' || entry.name === '..') continue;

        const full = `${dir}/${entry.name}`;

        if (entry.isDirectory) files.push(...await listRemote(client, full, base));
        else files.push(full.slice(base.length + 1));
    }

    return files;
};

const deploy = async () => {
    const config = readConfig();

    const theme = clean ? null : listThemeFiles();

    if (!clean && !skipBuild) {
        build();
        timer.lap('build');
    }

    const files = clean ? new Map() : collectFiles(config, theme.files);
    // Each file is read once, so the recorded hash and size always match the bytes uploaded, even if the file is edited during the deploy.
    const contents = new Map([...files].map(([name, file]) => [name, readFileSync(file)]));
    const hashes = Object.fromEntries([...contents].map(([name, data]) => [name, sha1(data)]));
    const sizes = Object.fromEntries([...contents].map(([name, data]) => [name, data.length]));
    const local = gitInfo();

    timer.lap('local files');

    console.log(`\nConnecting to ${config.host} …`);

    let client = await connect(config);

    const withRetry = async (label, action) => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await action();
            } catch (error) {
                if (attempt >= RETRIES || isServerReply(error)) {
                    throw Object.assign(new DeployError(`${label}: ${error.message}`), { serverReply: isServerReply(error) });
                }

                console.log(`  connection problem (${error.message}), retrying …`);
                client.close();
                client = await connect(config);
            }
        }
    };

    const removeFile = async (name) => {
        try {
            await withRetry(name, () => client.remove(`${config.remoteDir}/${name}`));
            return true;
        } catch (error) {
            if (!error.serverReply) throw error;
            console.log(`  could not delete ${error.message}`);
            return false;
        }
    };

    try {
        let rootEntries;

        try {
            rootEntries = await client.list(config.remoteDir);
        } catch (error) {
            throw new DeployError(`cannot open ${config.remoteDir} on the server (${error.message}). Check remoteDir.`);
        }

        if (!rootEntries.some((entry) => entry.name === 'style.css')) {
            throw new DeployError(`${config.remoteDir} does not look like the theme folder on the server (no style.css there). Check remoteDir.`);
        }

        const wpRoot = path.posix.dirname(path.posix.dirname(path.posix.dirname(config.remoteDir)));
        const environment = await withRetry('wp-config.php', () => readEnvironment(client, wpRoot));
        const production = !TEST_ENVIRONMENTS.includes(environment);

        console.log(production
            ? `Production server: ${describeEnvironment(environment)}. Changes ask for confirmation.`
            : `Test server: WP_ENVIRONMENT_TYPE is '${environment}'.`);

        const hasLegacyState = rootEntries.some((entry) => entry.name === LEGACY_STATE_FILE);
        const stateName = [STATE_FILE, LEGACY_STATE_FILE].find((name) => rootEntries.some((entry) => entry.name === name));
        const lastDeploy = stateName ? await readState(client, `${config.remoteDir}/${stateName}`) : null;
        const state = lastDeploy?.files || null;
        const remoteDist = new Set(rootEntries.some((entry) => entry.name === 'dist' && entry.isDirectory)
            ? (await listRemote(client, `${config.remoteDir}/dist`)).map((name) => `dist/${name}`)
            : []);

        timer.lap('server: connect and read state');

        if (clean) {
            if (!lastDeploy) throw new DeployError('there is no deploy state on the server, so the current build is unknown. Deploy first.');
            if (lastDeploy.unfinished) throw new DeployError('the last deploy did not finish. Run the deploy again first.');

            const oldBuild = [...remoteDist].filter((name) => !(name in state)).sort();

            console.log(`\nOld build files to delete: ${oldBuild.length}`);
            oldBuild.forEach((name) => console.log(`  - ${name}`));

            if (dryRun) {
                console.log('\nDry run: nothing was changed on the server.');
                return;
            }

            if (!oldBuild.length) return;
            if (production) {
                await confirmProduction(config, `This deletes ${oldBuild.length} old build files`);
                timer.lap('waiting for your confirmation');
            }

            let removed = 0;

            for (const name of oldBuild) {
                if (await removeFile(name)) removed += 1;
            }

            timer.lap('delete old build');

            console.log(`\nDone: ${removed} old build files deleted.`);
            return;
        }

        const toUpload = Object.keys(hashes)
            .filter((name) => uploadAll || !state || state[name] !== hashes[name])
            .sort((a, b) => (a === LAST_FILE) - (b === LAST_FILE) || b.startsWith('dist/') - a.startsWith('dist/') || a.localeCompare(b));

        const outdated = [...new Set([...Object.keys(state || {}), ...remoteDist])]
            .filter((name) => !(name in hashes) && (!name.startsWith('dist/') || remoteDist.has(name)));
        const previousBuild = outdated.filter((name) => name.startsWith('dist/') && (!state || name in state)).sort();
        const toDelete = outdated.filter((name) => !previousBuild.includes(name)).sort();

        console.log(state ? `Last deploy state found: ${Object.keys(state).length} files.` : 'No deploy state on the server yet: every theme file will be uploaded once.');
        console.log(`\nTo upload: ${toUpload.length}`);
        toUpload.forEach((name) => console.log(`  + ${name}`));
        console.log(`\nTo delete on the server: ${toDelete.length}`);
        toDelete.forEach((name) => console.log(`  - ${name}`));

        if (previousBuild.length) console.log(`\nPrevious build kept on the server for cached pages: ${previousBuild.length} files`);

        const problems = [];
        const warnings = [];

        if (lastDeploy && !force) {
            const last = describeDeploy(lastDeploy);

            if (lastDeploy.commit && !hasCommit(lastDeploy.commit)) {
                problems.push(`The last deploy (${last}) was made from commit ${lastDeploy.commit.slice(0, 7)}, which your branch does not have. Run git pull first.`);
            }

            if (lastDeploy.dirty) warnings.push(`The last deploy (${last}) included uncommitted changes: some of its files may be missing from git.`);
            if (lastDeploy.unfinished) warnings.push(`The last deploy (${last}) did not finish: this one uploads the rest.`);

            const changed = [];
            const stateTime = await withRetry(stateName, () => client.lastMod(`${config.remoteDir}/${stateName}`));
            const watched = [...toUpload, ...toDelete].filter((name) => !name.startsWith('dist/') && name in state);

            if (watched.length) console.log(`\nChecking ${watched.length} files on the server for changes made outside this script …`);

            for (const name of watched) {
                const remote = `${config.remoteDir}/${name}`;
                let time;
                let size;

                try {
                    [time, size] = await withRetry(name, async () => [await client.lastMod(remote), await client.size(remote)]);
                } catch (error) {
                    if (error.serverReply) continue;
                    throw error;
                }

                const sizeChanged = lastDeploy.sizes?.[name] !== undefined && lastDeploy.sizes[name] !== size;

                if (time > stateTime || sizeChanged) changed.push(`${name} (changed on the server ${time.toLocaleString()})`);
            }

            timer.lap('server: check for changes');

            if (changed.length) {
                problems.push([
                    'Changed on the server after the last deploy, not by this script. They would be overwritten or deleted:',
                    ...changed.map((line) => `  ! ${line}`),
                    'Download and compare them first.',
                ].join('\n'));
            }
        }

        if (local.dirty) warnings.push('You are deploying uncommitted changes.');

        if (theme.untracked.length) {
            warnings.push([
                'New files that git does not track yet, deployed from your disk. Make sure they belong on the server:',
                ...theme.untracked.map((file) => `  ? ${file}`),
            ].join('\n'));
        }

        warnings.forEach((line) => console.log(`\nWarning: ${line}`));
        problems.forEach((line) => console.log(`\nStop: ${line}`));

        if (dryRun) {
            console.log(problems.length
                ? '\nDry run: nothing was changed on the server. A real deploy would stop here; --force deploys anyway.'
                : '\nDry run: nothing was changed on the server.');
            return;
        }

        if (problems.length) throw new DeployError('nothing was changed on the server. Fix the above or run with --force to deploy anyway.');

        if (!toUpload.length && !toDelete.length) {
            console.log('\nThe server is up to date.');
            return;
        }

        if (production) {
            await confirmProduction(config, 'This deploys the theme');
            timer.lap('waiting for your confirmation');
        }

        const ensured = new Set();
        const uploaded = new Set();
        const deleted = new Set();
        const staged = [];
        let interrupted = false;

        const remotePath = (name, prefix = '') => `${config.remoteDir}/${path.posix.join(path.posix.dirname(name), prefix + path.posix.basename(name))}`;

        const remoteSize = (file) => client.size(file).catch((error) => {
            ignoreServerReply(error);
            return null;
        });

        const onInterrupt = () => {
            if (interrupted) process.exit(130);

            interrupted = true;
            console.log('\n  Stopping at the next safe point … Press Ctrl+C again to quit at once.');
        };

        const swap = async (name) => {
            const temp = remotePath(name, TEMP_PREFIX);
            const target = remotePath(name);

            try {
                await client.rename(temp, target);
            } catch (error) {
                ignoreServerReply(error);

                // The rename may have gone through while its reply was lost with the connection.
                if ((await remoteSize(temp)) === null) {
                    if ((await remoteSize(target)) === sizes[name]) return;
                    throw error;
                }

                // Some FTP servers refuse to rename over an existing file: move the old one aside and put it back if the switch fails.
                const old = remotePath(name, OLD_PREFIX);

                await client.remove(old).catch(ignoreServerReply);
                await client.rename(target, old);

                try {
                    await client.rename(temp, target);
                } catch (renameError) {
                    await client.rename(old, target).catch(ignoreServerReply);
                    throw renameError;
                }

                await client.remove(old).catch(ignoreServerReply);
            }
        };

        // An unfinished deploy keeps the old hashes of files it has not switched yet, so the next run finishes them without a false "changed on the server" stop.
        const writeState = (finished) => {
            const stateFiles = {};
            const stateSizes = {};

            for (const name of new Set([...Object.keys(hashes), ...Object.keys(state || {})])) {
                if (name in hashes && (finished || uploaded.has(name) || state?.[name] === hashes[name])) {
                    stateFiles[name] = hashes[name];
                    stateSizes[name] = sizes[name];
                } else if (!finished && state?.[name] && !deleted.has(name)) {
                    stateFiles[name] = state[name];
                    if (lastDeploy.sizes?.[name] !== undefined) stateSizes[name] = lastDeploy.sizes[name];
                }
            }

            const stateBody = STATE_GUARD + JSON.stringify({
                deployedAt: new Date().toISOString(),
                by: local.by,
                commit: local.commit,
                dirty: local.dirty,
                ...(finished ? {} : { unfinished: true }),
                files: stateFiles,
                sizes: stateSizes,
            });

            return withRetry(STATE_FILE, () => client.uploadFrom(Readable.from([stateBody]), `${config.remoteDir}/${STATE_FILE}`));
        };

        process.on('SIGINT', onInterrupt);

        try {
            for (const [index, name] of toUpload.entries()) {
                if (interrupted) throw new DeployError('stopped with Ctrl+C.');

                const direct = name.startsWith('dist/') && !remoteDist.has(name);
                const target = direct ? remotePath(name) : remotePath(name, TEMP_PREFIX);
                const dir = path.posix.dirname(target);

                await withRetry(name, async () => {
                    if (!ensured.has(dir)) {
                        await client.ensureDir(dir);
                        ensured.add(dir);
                    }

                    await client.uploadFrom(Readable.from([contents.get(name)]), target);
                });

                if (direct) uploaded.add(name);
                else staged.push(name);

                console.log(`  [${index + 1}/${toUpload.length}] uploaded ${name}`);
            }

            timer.lap('upload');

            if (staged.length) console.log(`\nSwitching ${staged.length} files to the new version …`);

            for (const name of staged) {
                await withRetry(name, () => swap(name));
                uploaded.add(name);
            }

            if (staged.length) timer.lap('switch files');

            for (const name of toDelete) {
                if (interrupted) throw new DeployError('stopped with Ctrl+C.');
                if (await removeFile(name)) deleted.add(name);
            }

            if (toDelete.length) timer.lap('delete');

            await writeState(true);
            timer.lap('save state');
        } catch (error) {
            if (uploaded.size || deleted.size) {
                try {
                    await writeState(false);
                    console.log(`\nProgress saved: ${uploaded.size} uploaded, ${deleted.size} deleted. Run the deploy again to finish.`);
                } catch (stateError) {
                    console.log(`\nCould not save the progress (${stateError.message}). The next deploy may stop on the files uploaded now: check them, then run with --force.`);
                }
            }

            for (const name of staged.filter((stagedName) => !uploaded.has(stagedName))) {
                await client.remove(remotePath(name, TEMP_PREFIX)).catch(() => { });
            }

            throw error;
        } finally {
            process.off('SIGINT', onInterrupt);
        }

        if (hasLegacyState) {
            try {
                await client.remove(`${config.remoteDir}/${LEGACY_STATE_FILE}`);
            } catch (error) {
                if (!isServerReply(error)) throw error;
                console.log(`  could not delete the old ${LEGACY_STATE_FILE}: ${error.message}. Delete it over FTP by hand.`);
            }
        }

        console.log(`\nDone: ${uploaded.size} uploaded, ${deleted.size} deleted.`);

        if (previousBuild.length) {
            console.log(`The previous build (${previousBuild.length} files) stays on the server for cached pages. After the page cache is cleared, delete it: ${cleanCommand()}`);
        }

        if (toUpload.some((name) => name.startsWith('acf-json/'))) {
            console.log('ACF field groups changed: open Custom Fields on the server and run Sync.');
        }
    } finally {
        client.close();
    }
};

try {
    await deploy();
} catch (error) {
    console.error(`\nDeploy stopped: ${error instanceof DeployError ? error.message : error.stack || error}`);
    process.exitCode = 1;
} finally {
    console.log(timer.summary());
}
