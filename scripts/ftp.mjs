// FTP connection and the production check shared by deploy.mjs, pull.mjs and push.mjs.
// Run directly (npm run ftp-cert -- [--config=deploy.other.json]) to pin the server's FTPS certificate in the config.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from 'basic-ftp';
import { phpDefine } from './wp-config.mjs';

export const TEST_ENVIRONMENTS = ['staging', 'development'];

// WP_ENVIRONMENT_TYPE from the server's wp-config.php (WordPress root or one level up): '' if not set, null if there is no wp-config.php.
export const readEnvironment = async (client, root) => {
    for (const file of [path.posix.join(root, 'wp-config.php'), path.posix.join(path.posix.dirname(root), 'wp-config.php')]) {
        const chunks = [];

        try {
            await client.downloadTo(new Writable({
                write(chunk, encoding, done) {
                    chunks.push(chunk);
                    done();
                },
            }), file);
        } catch (error) {
            if (typeof error?.code === 'number') continue;
            throw error;
        }

        return phpDefine(Buffer.concat(chunks).toString('utf8'), 'WP_ENVIRONMENT_TYPE') ?? '';
    }

    return null;
};

export const describeEnvironment = (environment) => {
    if (environment === null) return 'no wp-config.php was found next to WordPress';
    if (environment === '') return 'its wp-config.php does not set WP_ENVIRONMENT_TYPE, so WordPress treats it as production';

    return `its wp-config.php sets WP_ENVIRONMENT_TYPE to '${environment}'`;
};

export const accessOptions = (config) => {
    let secureOptions;

    if (config.secure && config.ca) secureOptions = { ca: config.ca, checkServerIdentity: () => undefined };
    else if (config.secure) secureOptions = { rejectUnauthorized: config.rejectUnauthorized !== false };

    return {
        host: config.host,
        port: config.port || 21,
        user: config.user,
        password: config.password,
        secure: config.secure,
        secureOptions,
    };
};

export const connectionHint = (error) => {
    const message = error?.message || '';

    if (/certificate/i.test(message)) return ' The FTPS certificate is not trusted: run `npm run ftp-cert` to check and pin the current one.';

    // The server was not reached at all; a wrong FTP login gets an answer from it and does not match.
    if (/timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i.test(message)) {
        return ' The server did not answer: check host and port in the config, and the VPN if the server is only reachable through one.';
    }

    return '';
};

const pinCertificate = async () => {
    const themeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const configName = process.argv.slice(2).find((arg) => arg.startsWith('--config='))?.slice(9) || 'deploy.config.json';
    const configPath = path.resolve(themeDir, configName);

    if (!existsSync(configPath)) throw new Error(`${configName} not found. Copy deploy.config.example.json and fill it in.`);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const client = new Client(30000);

    try {
        await client.access(accessOptions({ ...config, secure: true, ca: '', rejectUnauthorized: false }));

        const cert = client.ftp.socket.getPeerCertificate(true);
        const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

        console.log(`Server certificate: ${cert.subject?.CN || '(no name)'}, issued by ${cert.issuer?.O || cert.issuer?.CN || '(unknown)'}`);
        console.log(`Valid until: ${cert.valid_to}`);
        console.log(`SHA-256: ${cert.fingerprint256}`);

        if (config.ca === pem && config.secure) {
            console.log(`\n${configName} already trusts this certificate.`);
            return;
        }

        writeFileSync(configPath, `${JSON.stringify({ ...config, secure: true, ca: pem }, null, 4)}\n`);
        console.log(`\nSaved to ${configName}: FTPS is on and only this certificate is accepted.`);
    } finally {
        client.close();
    }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await pinCertificate();
    } catch (error) {
        console.error(`\nCould not pin the certificate: ${error.message}`);
        process.exitCode = 1;
    }
}
