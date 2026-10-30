// Stage timings printed at the end of deploy, pull, push and restore.
const format = (ms) => {
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;

    const seconds = Math.round(ms / 1000);

    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

export const createTimer = () => {
    const start = performance.now();
    const stages = [];
    let last = start;

    return {
        lap(label) {
            const now = performance.now();

            stages.push([label, now - last]);
            last = now;
        },
        summary() {
            const width = Math.max(0, ...stages.map(([label]) => label.length));

            return [
                `\nTime: ${format(performance.now() - start)}`,
                ...stages.map(([label, ms]) => `  ${`${label}:`.padEnd(width + 1)} ${format(ms)}`),
            ].join('\n');
        },
    };
};
