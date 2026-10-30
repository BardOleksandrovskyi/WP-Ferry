// What changed between two database dumps made by these scripts, in words: push and restore:server show it before overwriting the server.
// The service changes to ignore (IGNORED_TABLES, IGNORED_OPTIONS) are tuned to the plugins of this site.
import { readFileSync } from 'node:fs';

// Changes WordPress and plugins make on their own: caches, logs, queues, cron.
const IGNORED_TABLES = /^(actionscheduler_|itsec_|wpforms_(analytics_|dashboard_|logs$|tasks_meta$|product_events_queue$)|cmplz_statistics$|fldr_email_logs$|tm_task|wpo_404_detector$|yoast_)/;
const IGNORED_OPTIONS = /^(_([a-z0-9]+_)?(site_)?transient_|cron$|rewrite_rules$|recently_edited$|recovery_keys$|can_compress_scripts$|user_count$|action_scheduler_|wpforms_(dashboard_|analytics_|email_summaries_|send_usage_|notifications$|admin_notices$|process_forms_locator_status$|product_events_|license_updates$)|webpc_(stats_|errors_cache$|token_data$|latest_version$)|stellarwp_telemetry|wp-optimize-(last-optimized|total-cleaned)|cmplz_(last_|transients$|sync_|detected_|translation_|vendorlist_)|edd_(sl|api_request)_[0-9a-f]{32}$|acf_pro_license_status$|acf_site_health$|folder_license_key_data_last$|(auto|core)_updater\.lock$)/;
const EDITOR_META = new Set(['_edit_lock', '_edit_last']);
const LOGIN_META = /^(session_tokens|community-events-location|.*dashboard_quick_press_last_post_id|.*user-settings(-time)?)$/;
const ACCOUNT_META = /^(.*capabilities|.*user_level|first_name|last_name|nickname|description|locale|_application_passwords)$/;
const ACTIVITY = new Set(['opened in the editor', 'logged in', 'used the admin']);

const ESCAPES = { 0: '\0', n: '\n', r: '\r', Z: '\x1a' };
const SIGNS = { created: '+', deleted: '-', edited: '~', 'opened in the editor': '·' };
const RANKS = { 'opened in the editor': 1, edited: 2, deleted: 3, created: 3 };

const parseRow = (row) => {
    const values = [];
    let i = 1;

    while (i < row.length) {
        if (row[i] === "'") {
            let value = '';

            for (i += 1; row[i] !== "'"; i += 1) {
                if (row[i] === '\\') {
                    i += 1;
                    value += ESCAPES[row[i]] ?? row[i];
                } else {
                    value += row[i];
                }
            }

            i += 1;
            values.push(value);
        } else {
            let end = i;

            while (row[end] !== ',' && row[end] !== ')') end += 1;
            values.push(row.slice(i, end) === 'NULL' ? null : row.slice(i, end));
            i = end;
        }

        if (row[i] === ')') break;
        i += 1;
    }

    return values;
};

// Tables of a dump made by sync.mjs: columns, primary key and raw rows (one per line).
export const parseDump = (file) => {
    const tables = new Map();
    let current = null;

    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.startsWith('CREATE TABLE `')) {
            current = { name: line.slice(14, line.indexOf('`', 14)), columns: [], key: [], rows: [] };
            tables.set(current.name, current);
        } else if (line.startsWith('INSERT INTO `')) {
            current = tables.get(line.slice(13, line.indexOf('`', 13)));
            current.rows.push(line.slice(line.indexOf(' VALUES (') + 8).replace(/[,;]$/, ''));
        } else if (current && line.startsWith('(')) {
            current.rows.push(line.replace(/[,;]$/, ''));
        } else if (current && line.startsWith('  `')) {
            current.columns.push(line.slice(3, line.indexOf('`', 3)));
        } else if (current && line.startsWith('  PRIMARY KEY (')) {
            current.key = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
        }
    }

    return tables;
};

export const diffDumps = (base, current) => {
    const changes = [];

    for (const name of new Set([...base.keys(), ...current.keys()])) {
        const before = base.get(name)?.rows || [];
        const after = current.get(name)?.rows || [];
        const beforeSet = new Set(before);
        const afterSet = new Set(after);
        const removedRows = before.filter((row) => !afterSet.has(row));
        const addedRows = after.filter((row) => !beforeSet.has(row));

        if (!removedRows.length && !addedRows.length) continue;

        const table = current.get(name) || base.get(name);
        const keyIndexes = table.key.map((column) => table.columns.indexOf(column));
        const index = (rows) => new Map(rows.map((row) => {
            const values = parseRow(row);

            return [keyIndexes.length ? keyIndexes.map((i) => values[i]).join('\u0001') : row, values];
        }));
        const old = index(removedRows);
        const fresh = index(addedRows);
        const entry = { name, columns: table.columns, added: [], changed: [], removed: [] };

        fresh.forEach((values, key) => (old.has(key) ? entry.changed.push([old.get(key), values]) : entry.added.push(values)));
        old.forEach((values, key) => {
            if (!fresh.has(key)) entry.removed.push(values);
        });

        changes.push(entry);
    }

    return changes;
};

const rowLookup = (dumps, name, column) => {
    const rows = dumps.map((dump) => {
        const table = dump.get(name);
        const byId = new Map();

        table?.rows.forEach((row) => byId.set(row.match(/^\('([^']*)'/)?.[1], row));

        return { table, byId };
    });

    return (id) => {
        for (const { table, byId } of rows) {
            const row = byId.get(String(id));

            if (row) {
                const values = parseRow(row);

                return Object.fromEntries(column.map((name) => [name, values[table.columns.indexOf(name)]]));
            }
        }

        return null;
    };
};

export const describeDatabase = (changes, prefix, dumps) => {
    const postInfo = rowLookup(dumps, `${prefix}posts`, ['post_title', 'post_type', 'post_parent', 'post_modified']);
    const userInfo = rowLookup(dumps, `${prefix}users`, ['user_login']);
    const posts = new Map();
    const users = new Map();
    const options = [];
    const other = [];
    let terms = 0;
    let comments = 0;
    let ignored = 0;

    const markPost = (id, note) => {
        let info = postInfo(id);

        if (info?.post_type === 'revision' && info.post_parent && info.post_parent !== '0') {
            id = info.post_parent;
            info = postInfo(id);
            note = 'edited';
        }

        const previous = posts.get(id);

        if (!previous || RANKS[note] > RANKS[previous.note]) posts.set(id, { note, info });
    };

    for (const entry of changes) {
        const suffix = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name;
        const field = (values, column) => values[entry.columns.indexOf(column)];
        const rows = [
            ...entry.added.map((values) => ['created', values]),
            ...entry.changed.map(([, values]) => ['edited', values]),
            ...entry.removed.map((values) => ['deleted', values]),
        ];

        if (IGNORED_TABLES.test(suffix)) {
            ignored += rows.length;
            continue;
        }

        if (suffix === 'posts') {
            rows.forEach(([note, values]) => markPost(field(values, 'ID'), note));
        } else if (suffix === 'postmeta') {
            const byPost = new Map();

            rows.forEach(([, values]) => byPost.set(field(values, 'post_id'), [...(byPost.get(field(values, 'post_id')) || []), field(values, 'meta_key')]));
            byPost.forEach((keys, id) => markPost(id, keys.every((key) => EDITOR_META.has(key)) ? 'opened in the editor' : 'edited'));
        } else if (suffix === 'options') {
            rows.forEach(([note, values]) => {
                const name = field(values, 'option_name');

                if (IGNORED_OPTIONS.test(name) || name.startsWith('_options_')) {
                    ignored += 1;
                    return;
                }

                options.push(`${SIGNS[note]} ${name.startsWith('options_') ? `Options Fields: ${name.slice(8)}` : name}`);
            });
        } else if (suffix === 'users') {
            rows.forEach(([note, values]) => users.set(field(values, 'ID'), note === 'edited' ? 'profile changed' : note));
        } else if (suffix === 'usermeta') {
            const byUser = new Map();

            rows.forEach(([, values]) => byUser.set(field(values, 'user_id'), [...(byUser.get(field(values, 'user_id')) || []), field(values, 'meta_key')]));
            byUser.forEach((keys, id) => {
                if (keys.some((key) => ACCOUNT_META.test(key))) users.set(id, users.get(id) || 'role or profile changed');
                else if (!users.has(id)) users.set(id, keys.every((key) => LOGIN_META.test(key)) ? 'logged in' : 'used the admin');
            });
        } else if (/^term(s|meta|_taxonomy|_relationships)$/.test(suffix)) {
            terms += rows.length;
        } else if (/^comment(s|meta)$/.test(suffix)) {
            comments += rows.length;
        } else {
            other.push(`${suffix}: ${entry.added.length} added, ${entry.changed.length} changed, ${entry.removed.length} deleted`);
        }
    }

    const lines = [];
    const activity = [];
    const postLines = [];
    const userLines = [];

    posts.forEach(({ note, info }, id) => {
        const label = info ? `"${info.post_title || '(no title)'}" (${info.post_type} ${id})` : `post ${id}`;
        const when = info?.post_modified && note !== 'deleted' ? `, ${info.post_modified}` : '';

        if (ACTIVITY.has(note)) activity.push(`${SIGNS[note]} ${label} — ${note}, not saved`);
        else postLines.push(`  ${SIGNS[note]} ${label} — ${note}${when}`);
    });

    users.forEach((note, id) => {
        const line = `~ ${userInfo(id)?.user_login || `user ${id}`} — ${note}`;

        if (ACTIVITY.has(note)) activity.push(line);
        else userLines.push(`  ${line}`);
    });

    if (postLines.length) lines.push('Pages, posts and media:', ...postLines);
    if (options.length) lines.push('Settings:', ...options.map((line) => `  ${line}`));
    if (userLines.length) lines.push('Users:', ...userLines);
    if (terms) lines.push(`Categories and tags: ${terms} rows changed`);
    if (comments) lines.push(`Comments: ${comments} rows changed`);
    if (other.length) lines.push('Other data:', ...other.map((line) => `  ${line}`));

    return { lines, activity, ignored };
};
