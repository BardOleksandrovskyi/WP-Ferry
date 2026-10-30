// Reads values from wp-config.php as PHP would: comments are skipped, comment markers inside strings are kept.
export const stripPhpComments = (source) => {
    let out = '';
    let i = 0;

    while (i < source.length) {
        const char = source[i];
        const next = source[i + 1];

        if (char === "'" || char === '"') {
            let end = i + 1;

            while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
            out += source.slice(i, end + 1);
            i = end + 1;
        } else if ((char === '#' && next !== '[') || (char === '/' && next === '/')) {
            const end = source.indexOf('\n', i);

            i = end === -1 ? source.length : end;
        } else if (char === '/' && next === '*') {
            const end = source.indexOf('*/', i + 2);

            out += ' ';
            i = end === -1 ? source.length : end + 2;
        } else {
            out += char;
            i += 1;
        }
    }

    return out;
};

const DOUBLE_QUOTE_ESCAPES = { n: '\n', r: '\r', t: '\t', v: '\v', e: '\x1b', f: '\f', '\\': '\\', $: '$', '"': '"' };

const unescapeDoubleQuoted = (text) => text.replace(
    /\\(?:([nrtvef\\$"])|([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u\{([0-9A-Fa-f]+)\})/g,
    (escape, simple, octal, hex, unicode) => {
        if (simple) return DOUBLE_QUOTE_ESCAPES[simple];
        if (octal) return String.fromCharCode(parseInt(octal, 8) & 255);
        if (hex) return String.fromCharCode(parseInt(hex, 16));

        return String.fromCodePoint(parseInt(unicode, 16));
    },
);

export const phpDefine = (source, key) => {
    const match = stripPhpComments(source).match(new RegExp(`define\\s*\\(\\s*(['"])${key}\\1\\s*,\\s*(['"])((?:\\\\.|(?!\\2).)*)\\2\\s*\\)`, 's'));

    if (!match) return null;

    return match[2] === "'" ? match[3].replace(/\\(['\\])/g, '$1') : unescapeDoubleQuoted(match[3]);
};

export const phpTablePrefix = (source) => stripPhpComments(source).match(/\$table_prefix\s*=\s*(['"])(.*?)\1\s*;/)?.[2] ?? null;
