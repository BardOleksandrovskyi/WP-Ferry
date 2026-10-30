# WP Ferry: deploy, pull and push

Three commands move the site between your local copy and a server over FTP(S), and two more put a backup back:

```
                     deploy  ──────────►  theme folder
   Local site        pull    ◄──────────  database, uploads, plugins         Server
   (your computer)   push    ──────────►  database, uploads, plugins
                                          (test servers only)
```

| Command | What it does | Direction | Servers |
|---|---|---|---|
| **deploy** | uploads the theme folder (PHP, acf-json, a fresh production build) | local → server | test and production |
| **pull** | copies the database, `wp-content/uploads`, `wp-content/plugins` | server → local | test and production |
| **push** | copies the database, `wp-content/uploads`, `wp-content/plugins` | local → server | test servers only |
| **restore** | puts a backup back into the local database | local only | — |
| **restore:server** | puts a server backup back into the server database | server only | test servers only |

WordPress core is never copied: update it with the button in the admin on each side.

**Contents**

1. [Everyday use](#everyday-use)
2. [Quick reference](#quick-reference)
3. [Requirements](#requirements)
4. [Setup](#setup)
5. [Test server or production](#test-server-or-production)
6. [Deploy](#deploy)
7. [Pull](#pull)
8. [Restore](#restore)
9. [Push](#push)
10. [Restore on the server](#restore-on-the-server)
11. [Backups and snapshots](#backups-and-snapshots)
12. [Security](#security)
13. [When something stops](#when-something-stops)
14. [Limits](#limits)
15. [Changing the URL replacement](#changing-the-url-replacement)
16. [Moving the scripts to another project](#moving-the-scripts-to-another-project)

---

## Everyday use

| Situation | What to run |
|---|---|
| You start working, the content lives on the server | `npm run pull` |
| You changed theme code (PHP, styles, scripts, acf-json) | commit, then `npm run deploy` |
| You changed content or plugins locally and the server should get them | `npm run push -- --dry-run`, read the report, then `npm run push` |
| A pull or an import went wrong | `npm run restore`: puts back the local database as it was before the last pull |
| A push went wrong | `npm run restore:server`: puts back the server database as it was before the last push |
| Not sure what a command will do | add `-- --dry-run` (deploy, pull, push, restore:server): it only shows |

Pull replaces your local database with the server's, push replaces the server's with yours. Each saves a copy of the database it replaces first, on your computer (see [Backups and snapshots](#backups-and-snapshots)).

---

## Quick reference

Run every command from the theme folder.

| What | Dev server | Production |
|---|---|---|
| Pin the FTPS certificate | `npm run ftp-cert` | `npm run ftp-cert:prod` |
| Deploy the theme | `npm run deploy` | `npm run deploy:prod` |
| Delete the previous build | `npm run deploy:clean` | `npm run deploy:clean:prod` |
| Server → local | `npm run pull` | `npm run pull:prod` |
| Local → server | `npm run push` | never |
| Put a backup back into the local database | `npm run restore` (the newest) or `npm run restore -- "<file.sql>"` | |
| Put a backup back into the server database | `npm run restore:server` (the newest) or `npm run restore:server -- "<file.sql>"` | never |
| Check the two copies of the URL replacement | `npm run check:serialized` | |

Flags go after `--`, for example `npm run deploy:prod -- --dry-run`.

**Always preview first:** deploy, deploy:clean, pull, push and restore:server accept `--dry-run`. It shows what would change and changes nothing.

Every run of deploy, pull, push, restore and restore:server ends with **Time**: the total and how long each stage took, also when the run stops early.

| Command | Flags |
|---|---|
| deploy | `--dry-run` preview · `--skip-build` reuse the last build in `.deploy/dist` · `--force` skip the safety checks · `--all` upload every theme file, not only the changed ones |
| deploy:clean | `--dry-run` |
| pull | `--dry-run` · `--db-only` · `--uploads-only` · `--plugins-only` (combinable) · `--keep-local` keep local files and plugins that the server does not have · `--legacy-db` see below |
| push | `--dry-run` · `--db-only` · `--uploads-only` · `--plugins-only` (combinable) · `--mirror` also delete what only the server has · `--force` push even if the server changed since your last pull · `--legacy-db` see below |
| restore | `--dry-run` · `--legacy-db` see below |
| restore:server | `--dry-run` |
| check:serialized | `--count=N` how many random values (500) · `--seed=N` repeat a run · `--show=N` print one value in full |
| all but check:serialized | `--config=deploy.other.json` use another config file |

**`--legacy-db` (temporary):** pull, push and restore work with the local database from Node. Until that has run for a while, `--legacy-db` switches back to the previous way: the MySQL and PHP programs of Local, Local on Windows only. It will be removed.

---

## Requirements

- **Node** `^24.15` (see `engines` in `package.json`) and the theme's `node_modules` installed.
- **git**: deploy takes the file list from git.
- **FTP access** to the server; FTPS is strongly recommended.
- **For deploy only:** a webpack build in the theme (see [Moving the scripts to another project](#moving-the-scripts-to-another-project)).
- **For pull and push only:**
  - A local WordPress with its database **running**: Local, MAMP, WampServer, XAMPP or anything else, on Windows or Mac. No MySQL or PHP programs are needed: the scripts talk to the database from Node. They find it in this order:
    1. `localDb` in the config, if it sets `host`, `port` or `socket`;
    2. [Local](https://localwp.com): the site this theme belongs to, through Local's `sites.json`;
    3. `wp-config.php`: `DB_NAME`, `DB_USER`, `DB_PASSWORD` and `DB_HOST`. `localhost` without a port is tried as `127.0.0.1:3306`, the MAMP socket and `127.0.0.1:8889`.

    If none answers, the script lists what it tried; set `localDb` then.
  - The server site must be reachable over **https** (`siteUrl`).
  - The table prefix must be the same locally and on the server.

---

## Setup

1. Copy `deploy.config.example.json` to `deploy.config.json` (ignored by git) and fill it in:

   | Field | Required | Meaning |
   |---|---|---|
   | `host` | yes | FTP server address |
   | `port` | no | FTP port, `21` by default |
   | `user`, `password` | yes | FTP login |
   | `secure` | no | `true` for FTPS (recommended) |
   | `ca` | no | the pinned server certificate; filled in by `npm run ftp-cert` |
   | `remoteDir` | yes | the theme folder on the server, e.g. `/home/site/public_html/wp-content/themes/your-theme` |
   | `siteUrl` | for pull and push | the site address, starting with `https://` |
   | `sourceMaps` | no | `true` also uploads `.map` files of the build |
   | `localDb` | no | the local database, if it is not found on its own: `{ "host": "127.0.0.1", "port": 3306 }` or `{ "socket": "/path/mysql.sock" }`, plus `database`, `user`, `password` if they differ from `wp-config.php` |
   | `backupDir` | no | where pull, push, restore and restore:server keep backups and snapshots, relative to the theme or absolute. Default: `app/sql` in Local, `~/wp-sync-backups/<site folder>/<theme folder>` elsewhere (see [Backups and snapshots](#backups-and-snapshots)) |
   | `keepBackups` | no | how many backups and snapshots of each kind are kept; older ones are deleted after each successful pull, push, restore and restore:server. Default `5`, `0` keeps everything |

2. Pin the FTPS certificate: `npm run ftp-cert`. It connects, shows the certificate (name, expiry, SHA-256) and saves it into `ca`. From then on only this certificate is accepted. If the server certificate changes, the scripts stop with a certificate error: check the new one and run `npm run ftp-cert` again.

3. Mark the server: see [Test server or production](#test-server-or-production).

4. Preview: `npm run deploy -- --dry-run`, `npm run pull -- --dry-run`.

**Production** uses its own file, `deploy.prod.json` (also ignored by git), and the commands ending in `:prod`. The first deploy to a new server: `npm run deploy:prod -- --dry-run`.

FTP details live only in `deploy.*.json` files. Deploy never uploads them (except the example), so keep passwords nowhere else in the theme.

---

## Test server or production

The scripts ask the server itself what it is. They read `WP_ENVIRONMENT_TYPE` from the server's `wp-config.php` (in the WordPress root or one level up):

```php
define('WP_ENVIRONMENT_TYPE', 'staging');
```

| Value on the server | Treated as | deploy, deploy:clean | push, restore:server |
|---|---|---|---|
| `staging`, `development` | test server | run as usual | allowed |
| `production`, any other value, not set, no `wp-config.php` | production | ask you to type the domain first | refused |

It does not matter which config file holds the details: a production server is recognised by its own `wp-config.php`. Push and restore:server also refuse `deploy.prod.json` by name.

- Keep `'staging'` in the **dev server's** `wp-config.php`.
- Make sure the **production** `wp-config.php` does **not** have it. It must go anyway: on a non-production site Yoast does not build its SEO data (indexables).

Deploy, push and restore:server show what they found: `Test server: WP_ENVIRONMENT_TYPE is 'staging'.` or `Production server: …`.

---

## Deploy

`npm run deploy` uploads the theme. Only the theme folder changes; the database, uploads and plugins stay as they are.

### What it uploads

- Every theme file that git tracks or would add (`git ls-files --cached --others --exclude-standard`). `.gitignore` is the only exclude list, so `node_modules` and `deploy.config.json` stay local.
- Files are taken from the working directory, not from the last commit: **uncommitted changes are deployed too** (the script warns).
- `dist` comes from a fresh production build in `.deploy/dist`, not from your local `dist`. A running `npm run start` is not affected.
- Never uploaded: `deploy.*.json` except the example, the file passed with `--config`, source maps (unless `"sourceMaps": true`).
- **Blocked:** database dumps, archives, logs, backups and keys (`.sql`, `.zip`, `.gz`, `.tar`, `.7z`, `.rar`, `.log`, `.bak`, `.env`, `.pem`, `.key` and similar). If such a file sits in the theme folder and is not in `.gitignore`, deploy stops before building and lists it.
- Files git does not track yet are deployed too, but listed in a warning: check that they belong on the server.

### Step by step

1. **Build** the production bundle into `.deploy/dist` (`--skip-build` reuses the last one).
2. **Connect** and check that `remoteDir` is a theme folder (has `style.css`), read the server mark (see above) and the deploy state.
3. **Compare** the files with the state of the last deploy (SHA-1 hashes): only changed files are uploaded, files deleted locally are deleted on the server. The first deploy uploads everything.
4. **Safety checks.** The deploy stops, changing nothing, if:
   - the last deploy was made from a commit your branch does not have: run `git pull` first;
   - files it would overwrite or delete were changed on the server after the last deploy, not by this script (newer time or another size): download and compare them first.

   `--force` skips both. Warnings that do not stop: the last deploy included uncommitted changes, the last deploy did not finish, you are deploying uncommitted changes.
5. **Production only:** type the domain to continue.
6. **Upload in two steps,** so the site never runs a half-uploaded file:
   - changed files go next to the live ones under temporary names (`.deploying-…`); the site still runs the old version;
   - then they are renamed into place one after another, which takes seconds. New built CSS and JS (new names) are uploaded directly: nothing asks for them until `webpack-assets.json` is switched, and it goes last.
7. **Delete** files that no longer exist locally.
8. **Save the state** and remind you to run Sync in Custom Fields if `acf-json` changed.

### The deploy state

`deploy-state.php` in the theme folder on the server records every file's hash and size, who deployed, the commit and whether it had uncommitted changes. Its first line returns 404, so the browser cannot read it. Do not delete it: without it the next deploy uploads everything and cannot check for changes made on the server.

### If a deploy is interrupted

Connection lost after retries, or Ctrl+C: the deploy saves what it has done, and the next run uploads the rest without a false alarm. The first Ctrl+C stops at the next safe point (never in the middle of switching files); a second Ctrl+C quits at once.

### The previous build and deploy:clean

Built CSS and JS get new names on every build (`bundle.<hash>.css`). A page cached by the hosting or a CDN still asks for the old names, so deleting them right away would leave cached pages without styles until the cache is cleared.

- Deploy keeps the previous build on the server and says so.
- After the page cache is cleared, delete it: `npm run deploy:clean` (`npm run deploy:clean:prod` for production; `-- --dry-run` to preview). It builds and uploads nothing, it only deletes build files that are not part of the last deploy.
- On a server without a page cache, run it whenever you like.

---

## Pull

`npm run pull` copies the server into the local site: the database, uploads and plugins. Use `--db-only`, `--uploads-only`, `--plugins-only` for some parts.

Pull replaces your local data with the server's. If your local copy has changes the server should keep, push them first.

### Before changing anything, pull stops if

- the database would go to an older WordPress than the server's: update WordPress in Local first;
- a plugin it brings needs a newer WordPress or PHP than Local has;
- a plugin it would overwrite or delete has uncommitted changes in git: commit or discard them.

`--dry-run` shows these too. If only the WordPress version differs and the database format is the same, pull just warns.

### Database

1. Backs up all tables of the local database to `app/sql/local/backup-before-pull-<date>.sql`, in one consistent snapshot. The file gets its name only when the backup is complete. To undo a pull: `npm run restore`. If the pull stops before the import, the backup is deleted again: the local database has not changed.
2. Downloads the server database. A one-time PHP file is uploaded to the WordPress root, called once over https, and removed. The copy is saved as a snapshot `app/sql/<domain>/snapshot-<date>.sql`.
3. Imports it into Local.
4. Replaces the server URLs with the local ones everywhere, including serialized data and JSON (`\/`).

Tables that exist only locally are kept. Afterwards log in locally with your **server** user.

If the import or the URL replacement stops (an error or Ctrl+C), the local database may be half-imported: pull prints the `npm run restore` command with the backup to put it back.

### Uploads

- New and changed files are downloaded (compared by name and size).
- Local files the server does not have are deleted; `--keep-local` keeps them.
- Not pulled: WebP Converter copies (`uploads-webpc`) and files each site writes for itself (`uploads/.htaccess`, the WPForms cache, iThemes Security files).

### Plugins

- Plugin folders are compared file by file (MD5); new and changed files arrive in one pack.
- Local MD5s are cached in `.deploy/plugin-hashes.json` of the theme (pull and push): a file is read again only when its size, modification time, change time or file ID differs. Without the cache every plugin file is read, and the antivirus may check each one, which can take minutes. Deleting the cache is safe: the next run rebuilds it. The server side is always hashed in full.
- Local plugins the server does not have are deleted; `--keep-local` keeps them.
- Review the changes in git and commit them.

---

## Restore

`npm run restore` puts the newest backup in `app/sql/local` back into the local database: the state before the last pull or restore. Run it again and it undoes that restore.

`npm run restore -- "<file.sql>"` takes the file you name: any backup in `local`, a server backup or snapshot, or any dump made by these scripts or by `mysqldump`, plain or `.sql.gz`. A relative path is taken from the folder you run the command in.

Before anything changes:

- it checks that the file is complete: a cut file, a `.part` file or an unfinished mysqldump file is refused (a cut file would drop tables and then stop);
- a backup with another table prefix is refused;
- it shows the database it will write to and asks you to type its name. Ctrl+C at the question cancels.

Then:

- the current state is saved as `local/backup-before-restore-<date>.sql`, so a restore can be undone the same way;
- tables the backup contains are replaced; tables it does not contain are left as they are;
- a server backup or snapshot (from the server's folder, e.g. `app/sql/<domain>/snapshot-<date>.sql`) can be restored too: its URLs are replaced with the local ones, as in pull. This happens only when the local address can be read from the database; otherwise the URLs stay as they are and restore says so.

Restore needs no FTP details: `deploy.config.json` is read only for `localDb`, `backupDir` and `keepBackups`, and may be missing.

---

## Push

`npm run push` copies the Local site to a **test server**: the database, uploads and plugins. It refuses to run on production (see [Test server or production](#test-server-or-production)). Always run `npm run push -- --dry-run` first.

### Has the server changed since your last pull?

Push compares the server with the snapshot from your last pull, push or restore:server (`app/sql/<domain>/snapshot-…`). If someone changed it since, push stops and lists what:

- pages, posts and media (with titles), Settings, Options Fields;
- users whose role or profile changed;
- categories, comments, other tables;
- uploads and plugins changed on the server.

What to do:

1. Keep the server changes: `npm run pull`, then redo your local changes.
2. Overwrite them: `npm run push -- --force`. The server database is backed up first.
3. Small changes: make them by hand in the server admin instead.

**Ignored:** caches, logs, queues, cron, license checks. **Shown but not stopping:** logins, admin use, pages opened in the editor without saving.

Push also stops if:

- there is no snapshot yet: run `npm run pull` first;
- the database would go to an older WordPress than it comes from: update WordPress on the server first (if only the version differs and the database format is the same, push just warns);
- a plugin is newer on the server than locally: update it locally and commit;
- a plugin needs a newer WordPress or PHP than the server has.

`--force` pushes anyway.

### Confirmation

Before changing anything, push asks you to type the server domain. It needs a terminal; Ctrl+C at the question cancels.

### Order and what happens

**0. Local database dump.** Right after you confirm, push opens a fresh connection and dumps the local database. If that fails, nothing on the server has changed yet.

**1. Plugins**

- Only changed files are uploaded, in one pack.
- On the server each updated plugin is assembled in `wp-content/_sync`, then swapped in with one rename.
- The previous version is kept in `wp-content/_rollback` (one copy per plugin).
- Plugins only on the server are kept; `--mirror` moves them to `_rollback`.
- Without the database (`--plugins-only`), new plugins arrive inactive: activate them in the admin.

**2. Database**

1. The server database is backed up to `app/sql/<domain>/backup-before-push-<date>.sql` (this happens already when push compares the server, before the question). If push stops before changing the server (a check, no confirmation, Ctrl+C at the question), the backup is deleted again. To undo the push: `npm run restore:server` (see [Restore on the server](#restore-on-the-server)).
2. The local dump is encrypted (AES-256-GCM) and uploaded with a one-time importer.
3. On the server it is imported into temporary tables and the URLs are replaced. WebP Converter's saved list of errors is removed from them: it describes the site the database came from (Local often reports `rewrites_not_executed`), and any saved error makes the plugin skip conversions without a message, including images uploaded in the admin. The plugin checks the server again the next time its settings page is opened.
4. All tables are switched in one `RENAME`. If anything fails before that, the site stays on the old database.
5. A new snapshot of the server is saved. If that fails (the connection drops right then), push says so and goes on with the uploads: the database is replaced anyway. The next push then lists this push's own changes as server changes; if that is all it lists, push with `--force`.

Users travel with the database: log in on the server with your **local** user.

**3. Uploads**

- New and changed files are uploaded.
- Files only on the server are kept; `--mirror` deletes them.
- Old WebP Converter copies of replaced and deleted files are removed.
- New and replaced images are converted by WebP Converter on the server right away. If the plugin is not active there, this step is skipped. If conversion fails, push tells you to regenerate the images in the plugin.
- Images left without copies, for example pushed by an older version of these scripts: open the plugin's settings page on the server and run Bulk Optimization.
- Only WebP Converter for Media is handled. With another image optimization plugin, run its bulk optimization after a push, and give replaced images a new file name: its old copies are not removed. Push compares uploads by size, so originals that plugin compressed on the server are overwritten by your local files. If it keeps copies in `uploads`, `--mirror` deletes the ones your local site does not have.

---

## Restore on the server

`npm run restore:server` puts the newest backup in `app/sql/<domain>` back into the database of that **test server**: the state before the last push or restore:server. Run it again and it undoes that restore. It refuses to run on production, like push. Preview with `npm run restore:server -- --dry-run`.

`npm run restore:server -- "<file.sql>"` takes the file you name: an older `backup-before-push-…`, a `backup-before-restore-…` or a snapshot from the same folder. A relative path is taken from the folder you run the command in.

Before anything changes, it refuses:

- a file that was not made by these scripts (a `mysqldump` file, a database exported by hand);
- a cut or `.part` file;
- a backup of another site: its address must be the server's. A local database goes to the server only with `npm run push`, which checks what it would overwrite.

Then:

1. It downloads the current server database and saves it as `app/sql/<domain>/backup-before-restore-<date>.sql`, so the restore can be undone the same way. A table prefix that differs from the backup's is refused here.
2. It compares the server with the last snapshot and lists what changed since your last pull, push or restore:server, in the same words as push: pages, posts and media, Settings, users and so on. The restore removes these changes too, for example edits a colleague made on the dev site after your push. The list does not stop the restore: going back is the point, and the changes stay in the backup from step 1. `--dry-run` shows the list as well.
3. It asks you to type the server domain. If you do not, or the run stops before the import, the backup from step 1 is deleted again: the server has not changed.
4. It imports the backup on the server the same way push does: encrypted, into temporary tables, switched in one `RENAME`. If anything fails before that, the site stays on the old database.
5. It saves a new snapshot of the server, so the next push compares with the restored state. If the snapshot cannot be saved (the connection drops right then), restore says so: the database is restored anyway, and the next push lists the restored data as server changes. If that is all it lists, push with `--force`.

Only the database changes. Tables the backup does not contain are left as they are. Uploads and plugins stay as they are: push never deletes uploads without `--mirror`, and the plugin versions it replaced are in `wp-content/_rollback` on the server.

---

## Backups and snapshots

Where they go:

- **Local:** `app/sql`, next to `public` and outside the repository.
- **Anything else** (MAMP, WAMP, XAMPP …): `wp-sync-backups/<site folder>/<theme folder>` in your home folder, e.g. `C:\Users\you\wp-sync-backups\client-site\my-theme`. The site folder is the WordPress folder, or the first one above it with a non-generic name (not `public`, `htdocs`, `www` …). The folder next to WordPress would be inside the web server folder there, shared by all sites and readable in the browser.
- **`backupDir` in the config** overrides both.

Inside, the local database and each server have their own folder:

```
app/sql/
  local/                                the local database
    backup-before-pull-<date>.sql
    backup-before-restore-<date>.sql
  <domain>/                             one folder per server
    backup-before-push-<date>.sql
    backup-before-restore-<date>.sql
    snapshot-<date>.sql
    snapshot-<date>.uploads.json
    snapshot-<date>.plugins.json
```

Pull, push, restore and restore:server print the full path of every file they save. A backup is kept only if the command went on to change that database: pull, push and restore:server delete it again when they stop before that. So the newest backup in a folder is the state before the last real change, and `restore` / `restore:server` without a file name undo exactly that. The exception is a run killed halfway (Ctrl+C while it downloads, a closed terminal): its backup stays. Restore shows which file it takes before asking, so check the date there.

| File | Made by | What it is |
|---|---|---|
| `local/backup-before-pull-<date>.sql` | pull | your local database before the import |
| `local/backup-before-restore-<date>.sql` | restore | your local database before the restore |
| `<domain>/backup-before-push-<date>.sql` | push | the server database before it was replaced |
| `<domain>/backup-before-restore-<date>.sql` | restore:server | the server database before the restore |
| `<domain>/snapshot-<date>.sql` | pull, push, restore:server | snapshot: the server database right after your last pull, push or restore:server |
| `<domain>/snapshot-<date>.uploads.json` | pull, push | snapshot: the list of server uploads with sizes |
| `<domain>/snapshot-<date>.plugins.json` | pull, push | snapshot: the version and hash of each server plugin |

A production server gets a folder too, with the snapshots of `pull:prod`; push and restore:server never write there.

Files from earlier versions of these scripts, which lay in `app/sql` itself (`backup-before-push-<domain>-…`, `server-<domain>-…`), are moved into these folders on the first run and renamed.

Push uses only the newest snapshot of each kind. After each successful pull, push, restore and restore:server the scripts keep the last 5 files of each kind (`keepBackups` in the config) and delete older ones:

- `local` and the folder of the server in the config are cleaned; the folder of another server is cleaned when a command runs against it;
- each kind is counted on its own: pull backups, push backups, restore backups, and snapshots per type (`.sql`, `.uploads.json`, `.plugins.json`), so the newest snapshot of every type always stays;
- unfinished `.part` files older than an hour (left by an interrupted run) are deleted too; newer ones may belong to a run that is still going;
- anything else is never touched: `local.sql`, backups made by hand (`backup-before-<task>-…`), other folders, your own files.

---

## Security

- **FTPS with a pinned certificate:** only the certificate saved by `ftp-cert` is accepted, so nobody can sit in the middle.
- **One-time PHP files** (`sync-<random>.php` in the WordPress root): a random 32-character name, a secret key sent by POST over https, a 404 for anyone without the key. The file deletes itself on the first valid call and the script removes it over FTP as well. If that fails, the script prints the path: delete it by hand.
- **The database on the way to the server** is encrypted; the key travels separately, over https.
- **`deploy-state.php`** answers 404 to the browser.
- **FTP details** are only in `deploy.*.json`, ignored by git and never uploaded.

---

## When something stops

| Message | What to do |
|---|---|
| `certificate` error | The server certificate changed. Check it and run `npm run ftp-cert` again. |
| `could not connect to …` / `The server did not answer` | The server is not reachable from your computer. Check `host` and `port` in the config. If the server is only reachable through a VPN, turn it on. Nothing was changed. |
| `does not look like the theme folder` | Check `remoteDir` in the config. |
| `these files must never reach the server` | Move the listed files out of the theme folder, or delete them, or add them to `.gitignore`. A file marked `(in git)` is already committed: `git rm --cached <file>` (it stays on disk), then `.gitignore`. If it held passwords or keys, change them: they remain in the git history. |
| `was made from commit …, which your branch does not have` | Someone deployed newer code: `git pull`, then deploy. |
| `Changed on the server after the last deploy` | Someone edited theme files on the server. Download and compare them, then deploy (or `--force`). |
| `The last deploy … did not finish` | Just deploy again: it uploads the rest. |
| `deploy-state.php on the server is damaged` | Saving the deploy state was cut off. Delete `deploy-state.php` from the theme folder over FTP, then deploy: it uploads every theme file once. |
| `not marked as a test site` (push, restore:server) | Push and restore:server never run on production. On a dev server, add `define('WP_ENVIRONMENT_TYPE', 'staging');` to its `wp-config.php`. |
| `Since your last pull, push or restore:server … the server has changed` | See [Has the server changed](#has-the-server-changed-since-your-last-pull). Send unknown setting names to the developer: they may be service data to ignore. |
| `There is no snapshot …` | Run `npm run pull` first. |
| `… is newer on the server` | Update the plugin locally, commit, then push. |
| `older WordPress` | Update WordPress on the receiving side (Dashboard → Updates). |
| `redirects to …` | Put the final address (after redirects) in `siteUrl`. |
| `could not remove … sync-….php` | Delete that file from the server root over FTP. |
| `cannot reach the local database` | Start the site (Local, MAMP, WAMP …). If it runs, the database is elsewhere: set `localDb` in the config. |
| `cannot read the local site address` | A fresh local site: add `WP_HOME` to its `wp-config.php`. After an interrupted import: run `npm run restore`. |
| `the server table prefix … differs from the local` (pull) | Set `$table_prefix` in the local `wp-config.php` as the message says. |
| `import stopped` / `Pull interrupted during the import` | Run the `npm run restore` command printed below the message. |
| `is incomplete` / `unfinished file` (restore, restore:server) | The backup file is cut: pick an earlier backup. Nothing was changed. |
| `there are no backups … yet` (restore, restore:server) | Nothing to put back without a file name: name the file, or check `backupDir`. |
| `the backup comes from …, not from …` (restore:server) | The file is a backup of another site, e.g. the local one. Pick a file from the server's folder; a local database goes to the server with `npm run push`. |
| `was not made by these scripts` (restore:server) | Only backups and snapshots that push, pull and restore:server saved can go back to the server. |
| `cancelled, nothing was changed` | You pressed Ctrl+C at the question. |
| `uncommitted changes in plugins` (pull) | Commit or discard them first. |

---

## Limits

- Pull and push have been used with Local on Windows. Other setups (Mac, MAMP, WAMP, XAMPP) follow the same code but were not tried yet: run them with `--dry-run` first.
- First pull into a fresh local site: set `$table_prefix` in the local `wp-config.php` to the server's prefix, then pull. Pull takes the local address from the site's `options` table; if it does not exist yet, from Local, or from `WP_HOME` in `wp-config.php` (add it if the site is not in Local).
- Backups made by these scripts hold tables only. Views, triggers and stored procedures are not saved; WordPress and the usual plugins do not use them. Restore also cannot read dumps that define procedures or triggers (`DELIMITER`).
- An old `mysqldump` file made without `--hex-blob` cannot bring back `GEOMETRY` columns (MySQL itself cannot either); other binary data is fine.
- Tables are picked by the prefix: in a database shared by several sites, a site with prefix `wp_` also takes the tables of `wp_shop_`. Give each local site its own database.
- MySQL on Windows stores table names in lower case. Push gives them back the case they have on the server (`wp_wfConfig` of Wordfence, an upper-case prefix); a table the server does not have yet gets the prefix as written in `wp-config.php` and the rest in lower case.
- The theme must sit in `wp-content/themes` of the local site as a real folder. If it is a link to a folder elsewhere, pull and push do not find WordPress and stop with `wp-config.php not found`.
- Uploads are compared by name and size: a replaced file with exactly the same size is not noticed. Give changed images a new file name.
- Local plugin files are trusted by their size, times and file ID (the same idea as `git status`). Changing a file's content while keeping all four is not something ordinary tools do; if in doubt, delete `.deploy/plugin-hashes.json`.
- The "changed on the server" check of deploy covers only the files the deploy is about to overwrite or delete.
- Not synced: WordPress core, `wp-content/mu-plugins`, `wp-content/languages`, other themes, single-file plugins in the root of `plugins`.
- The database dump is held in memory as a whole by pull, push and restore:server (restore reads it in pieces). It must stay under 512 MB uncompressed, a limit of Node. On the server, push and restore:server also need PHP `memory_limit` larger than the dump plus its compressed copy; if it runs out, the import stops and the site stays on the old database. Sites of the usual size are far below both.
- Each run uses one FTP connection, one file at a time. Large first runs take a while; some servers close the connection after a few hundred commands, and the scripts reconnect.

---

## Changing the URL replacement

The replacement that keeps serialized data valid exists twice:

- `PHP_WALKER` in `sync.mjs`: runs on the server during push;
- `serialized.mjs`: its JavaScript copy, runs locally during pull.

They must give the same result. After changing either one, change the other and run:

```
npm run check:serialized
```

It runs the same values through both copies and compares them byte by byte: tricky fixed cases plus 500 random ones (nested arrays and objects, Cyrillic, emoji, JSON, broken data). It also reports valid serialized data that the replacement made unreadable. A failure prints the seed to repeat it with; `--count=20000` checks more values, `--show=N` prints one value in full. It needs PHP: the `PHP` environment variable, `php` in PATH or Local's PHP. No database is used.

---

## Moving the scripts to another project

What the project needs:

- **Deploy** needs a webpack build in the theme. It runs webpack from the theme's `node_modules` into `.deploy/dist` and expects the manifest `webpack-assets.json` in the build: the theme reads it to find the CSS and JS with hashed names, and deploy switches it last. A theme without such a build (no build step, Vite, Gulp) stops with `.deploy/dist has no build`: deploy has to be adapted first.
- **Pull, push, restore and restore:server** do not depend on the theme. They need the usual WordPress layout (`wp-content` in the WordPress root, the theme in `wp-content/themes`) and the theme in git.
- The service changes push and restore:server ignore (`IGNORED_TABLES` and `IGNORED_OPTIONS` in `db-changes.mjs`) are tuned to the plugins of this site. Other plugins may need their own entries: push lists their changes as server changes and stops.

Copy:

- the `scripts` folder;
- the `deploy`, `deploy:clean`, `pull`, `push`, `restore`, `restore:server`, `ftp-cert`, `check:serialized` commands and the `:prod` versions from `package.json`;
- `deploy.config.example.json`.

Then:

- add `basic-ftp` and `mysql2` to devDependencies with the exact versions from this `package.json` (no `^`);
- add `.deploy`, `deploy.config.json` and `deploy.prod.json` to `.gitignore`;
- set `define('WP_ENVIRONMENT_TYPE', 'staging');` in the dev server's `wp-config.php`;
- run the first deploy with `--dry-run`.
