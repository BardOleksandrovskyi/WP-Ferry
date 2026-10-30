# WP Ferry

Node.js scripts that deploy a WordPress theme and pull / push the database, uploads and plugins between a local site and a server. Plain FTP and HTTPS only: no SSH or WP-CLI on the server. Backups and safety checks before every overwrite.

```
                     deploy  ──────────►  theme folder
   Local site        pull    ◄──────────  database, uploads, plugins         Server
   (your computer)   push    ──────────►  database, uploads, plugins
                                          (test servers only)
```

## What it does

- **deploy** builds the theme and uploads only the files that changed. They are switched in place within seconds, so the site never runs a half-uploaded file. It stops if the last deploy was made from a commit your branch does not have, or if a file it would overwrite was changed on the server by hand.
- **pull** copies the server database, uploads and plugins to your local site. Site addresses are replaced, serialized data stays valid.
- **push** copies them back, to test servers only: a production server is refused. It first compares the server with your last pull or push and stops if someone changed it since.
- **restore** puts a backup back into the local database; without a file name, the state before the last pull.
- **restore:server** puts a backup back into the database of a test server; without a file name, the state before the last push.

Every command that overwrites a database backs it up first: pull and restore the local one, push and restore:server the server's. Backups of the local database and of each server are kept in separate folders, old ones are pruned automatically.

## Requirements

- Node `^24.15` and git: the theme must be in a git repository, deploy takes the file list from it.
- FTP access to the server (FTPS recommended) and the site reachable over https.
- For deploy: a webpack build in the theme that writes the manifest `webpack-assets.json`.
- For pull and push: a running local WordPress (Local, MAMP, WampServer, XAMPP or another) on Windows or Mac. So far they have been used with Local on Windows; run other setups with `--dry-run` first.

## Install

1. Copy the `scripts` folder and `deploy.config.example.json` into your theme folder, so the scripts sit in `wp-content/themes/<your-theme>/scripts`.
2. Add the `scripts` and `devDependencies` of this `package.json` to the theme's `package.json`, then run `npm install`.
3. Add to the `.gitignore` of your project:

   ```
   .deploy
   deploy.config.json
   deploy.prod.json
   ```

4. Copy `deploy.config.example.json` to `deploy.config.json` and fill in the FTP details, the theme folder on the server and the site address.
5. Mark the dev server as a test server in its `wp-config.php`: `define('WP_ENVIRONMENT_TYPE', 'staging');`. Push runs only on such servers, and deploy asks for confirmation on all others.
6. Pin the FTPS certificate and preview:

   ```
   npm run ftp-cert
   npm run deploy -- --dry-run
   npm run pull -- --dry-run
   ```

## Documentation

The full guide is in [scripts/README.md](scripts/README.md): every command and flag, the safety checks, backups, what to do when something stops, and the limits.

## License

[MIT](LICENSE)
