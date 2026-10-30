// JavaScript copy of PHP_WALKER in sync.mjs (sr_value): pull replaces URLs locally with this one, push on the server with the PHP one.
// Change both together and run npm run check:serialized: it compares them byte by byte.
// Strings are latin1, one character per byte, so lengths match PHP's strlen.
const SERIALIZED = /^(?:[aOCsbidrRE]:|N;)/;
const SCALAR_TOKEN = /[bidrR]:[^;:{}"]*;/y;
const STRING_TOKEN = /s:(\d+):"/y;
const ENUM_TOKEN = /E:(\d+):"/y;
const ARRAY_TOKEN = /a:(\d+):\{/y;
const OBJECT_TOKEN = /([OC]):(\d+):"/y;
const COUNT_TOKEN = /(\d+):\{/y;

class WalkError extends Error {}

const replaceAll = (value, from, to) => from.reduce((out, search, i) => out.split(search).join(to[i]), value);

const token = (pattern, s, position) => {
    pattern.lastIndex = position;

    const match = pattern.exec(s);

    if (!match) throw new WalkError();

    return match;
};

const walkItems = (s, state, count, from, to) => {
    let out = '';

    for (let i = 0; i < count * 2; i += 1) out += walk(s, state, from, to);
    if (s[state.pos] !== '}') throw new WalkError();
    state.pos += 1;

    return `${out}}`;
};

const walk = (s, state, from, to) => {
    const start = state.pos;

    switch (s[start] ?? '') {
        case 'N':
            if (s.substr(start, 2) !== 'N;') throw new WalkError();
            state.pos += 2;
            return 'N;';

        case 'b':
        case 'i':
        case 'd':
        case 'r':
        case 'R': {
            const match = token(SCALAR_TOKEN, s, start);

            state.pos += match[0].length;
            return match[0];
        }

        case 's': {
            const match = token(STRING_TOKEN, s, start);
            const valueStart = start + match[0].length;
            const length = Number(match[1]);

            if (s.substr(valueStart + length, 2) !== '";') throw new WalkError();

            const value = replaceSerialized(s.substr(valueStart, length), from, to);

            state.pos = valueStart + length + 2;
            return `s:${value.length}:"${value}";`;
        }

        case 'E': {
            const match = token(ENUM_TOKEN, s, start);
            const end = start + match[0].length + Number(match[1]) + 2;

            state.pos = end;
            return s.slice(start, end);
        }

        case 'a': {
            const match = token(ARRAY_TOKEN, s, start);

            state.pos += match[0].length;
            return match[0] + walkItems(s, state, Number(match[1]), from, to);
        }

        case 'O':
        case 'C': {
            const match = token(OBJECT_TOKEN, s, start);
            const nameEnd = start + match[0].length + Number(match[2]);

            if (s.substr(nameEnd, 2) !== '":') throw new WalkError();

            const count = token(COUNT_TOKEN, s, nameEnd + 2);
            const head = s.slice(start, nameEnd + 2 + count[0].length);

            state.pos = nameEnd + 2 + count[0].length;

            if (match[1] === 'C') {
                const raw = s.substr(state.pos, Number(count[1]));

                state.pos += Number(count[1]);
                if (s[state.pos] !== '}') throw new WalkError();
                state.pos += 1;
                return `${head}${raw}}`;
            }

            return head + walkItems(s, state, Number(count[1]), from, to);
        }

        default:
            throw new WalkError();
    }
};

export const replaceSerialized = (value, from, to) => {
    if (SERIALIZED.test(value)) {
        try {
            const state = { pos: 0 };
            const out = walk(value, state, from, to);

            if (state.pos === value.length) return out;
        } catch (error) {
            if (!(error instanceof WalkError)) throw error;
        }
    }

    return replaceAll(value, from, to);
};
