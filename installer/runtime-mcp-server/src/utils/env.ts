export function readEnv(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            return value;
        }
    }
    return undefined;
}
