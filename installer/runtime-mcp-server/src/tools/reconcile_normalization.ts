export type ReconciliationColumnRole =
    "identity"
    | "comparisonText"
    | "code"
    | "description"
    | "quantity"
    | "unit"
    | "system"
    | "discipline"
    | "notes";

export type ReconciliationTokenType = "code" | "number" | "unit" | "dimension" | "word";

export type ReconciliationToken = {
    type: ReconciliationTokenType;
    value: string;
};

export type ReconciliationTokenProfile = {
    profileVersion: 1;
    normalizedKey: string;
    tokens: ReconciliationToken[];
};

export const RECONCILIATION_REQUIRED_ROLES: ReconciliationColumnRole[] = ["identity", "comparisonText"];
export const RECONCILIATION_ALL_ROLES: ReconciliationColumnRole[] = ["identity", "comparisonText", "code", "description", "quantity", "unit", "system", "discipline", "notes"];

export const RECONCILIATION_ROLE_ALIASES: Record<ReconciliationColumnRole, string[]> = {
    identity: ["identity", "id", "key", "name", "item", "row", "code", "type", "mark", "tag", "poz", "kod", "ad", "isim"],
    comparisonText: ["comparisontext", "comparison text", "description", "desc", "aciklama", "text", "name", "item", "type", "mark", "tag", "ad", "isim"],
    code: ["code", "kod", "type code", "mark", "tag", "poz"],
    description: ["description", "desc", "text", "aciklama"],
    quantity: ["quantity", "qty", "count", "adet", "miktar"],
    unit: ["unit", "units", "birim"],
    system: ["system", "sistem"],
    discipline: ["discipline", "disiplin"],
    notes: ["notes", "note", "remarks", "remark", "not"],
};

const CYRILLIC_LOOKALIKE_MAP: Record<string, string> = {
    "\u0410": "A",
    "\u0430": "A",
    "\u0412": "B",
    "\u0432": "B",
    "\u0415": "E",
    "\u0435": "E",
    "\u041A": "K",
    "\u043A": "K",
    "\u041C": "M",
    "\u043C": "M",
    "\u041D": "H",
    "\u043D": "H",
    "\u041E": "O",
    "\u043E": "O",
    "\u0420": "P",
    "\u0440": "P",
    "\u0421": "C",
    "\u0441": "C",
    "\u0422": "T",
    "\u0442": "T",
    "\u0423": "Y",
    "\u0443": "Y",
    "\u0425": "X",
    "\u0445": "X",
};

const TURKISH_LETTER_MAP: Record<string, string> = {
    "\u00c7": "C",
    "\u00e7": "C",
    "\u011e": "G",
    "\u011f": "G",
    "\u00d6": "O",
    "\u00f6": "O",
    "\u015e": "S",
    "\u015f": "S",
    "\u00dc": "U",
    "\u00fc": "U",
};

const UNIT_TOKENS = new Set(["DN", "MM", "CM", "M", "KW", "KCALH", "LPS", "M3H"]);

export function cleanReconciliationText(value: unknown): string {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeReconciliationHeader(value: unknown): string {
    return cleanReconciliationText(value)
        .replace(/\u0131/g, "i")
        .replace(/\u0130/g, "I")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

export function normalizeReconciliationAlias(value: string): string {
    return normalizeReconciliationHeader(value).replace(/\s+/g, "");
}

export function normalizeReconciliationText(value: unknown): string {
    let text = String(value ?? "");
    text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    text = text.normalize("NFKC");
    text = text.replace(/\u0131/g, "i").replace(/\u0130/g, "I");
    text = text.replace(/[\u0400-\u04ff]/g, (char) => CYRILLIC_LOOKALIKE_MAP[char] || char);
    text = text.replace(/[\u00c7\u00e7\u011e\u011f\u00d6\u00f6\u015e\u015f\u00dc\u00fc]/g, (char) => TURKISH_LETTER_MAP[char] || char);
    text = text.toUpperCase();
    text = text.replace(/[\u00d8\u00f8\u2205\u2300\u0424\u0444]/g, " DN ");
    text = text.replace(/\b(?:DIAMETER|DIA)\b/g, " DN ");
    text = canonicalizeCompoundUnits(text);
    text = text.replace(/(\d),(\d)/g, "$1.$2");
    text = text.replace(/(\d)\.(\d)/g, "$1DECIMALDOT$2");
    text = text.replace(/[^A-Z0-9]+/g, " ");
    text = text.replace(/(\d)DECIMALDOT(\d)/g, "$1.$2");
    text = text.replace(/\bM\s*3\s*H\b/g, "M3H");
    return text.replace(/\s+/g, " ").trim();
}

export function buildReconciliationNormalizedKey(parts: unknown[]): string {
    const normalizedParts = parts
        .map((part) => normalizeReconciliationText(part))
        .filter((part, index, items) => part.length > 0 && items.indexOf(part) === index);
    return normalizedParts.join(" | ");
}

export function buildReconciliationTokenProfile(parts: unknown[]): ReconciliationTokenProfile {
    const normalizedKey = buildReconciliationNormalizedKey(parts);
    return {
        profileVersion: 1,
        normalizedKey,
        tokens: tokenizeReconciliationText(normalizedKey),
    };
}

export function tokenizeReconciliationText(value: unknown): ReconciliationToken[] {
    const normalized = normalizeReconciliationText(value);
    const rawTokens = normalized.length > 0 ? normalized.split(" ") : [];
    const tokens: ReconciliationToken[] = [];

    for (let index = 0; index < rawTokens.length; index++) {
        const current = rawTokens[index];
        const next = rawTokens[index + 1];

        if (isNumberToken(current) && next && UNIT_TOKENS.has(next)) {
            tokens.push({ type: "dimension", value: `${current}${next}` });
            index++;
            continue;
        }
        if (UNIT_TOKENS.has(current) && next && isNumberToken(next)) {
            tokens.push({ type: "dimension", value: `${current}${next}` });
            index++;
            continue;
        }
        const compactDimension = parseCompactDimension(current);
        if (compactDimension) {
            tokens.push({ type: "dimension", value: compactDimension });
            continue;
        }
        if (UNIT_TOKENS.has(current)) {
            tokens.push({ type: "unit", value: current });
            continue;
        }
        if (isNumberToken(current)) {
            tokens.push({ type: "number", value: current });
            continue;
        }
        const afterNext = rawTokens[index + 2] || "";
        const afterNextHasOwnNumber = UNIT_TOKENS.has(afterNext) && isNumberToken(rawTokens[index + 3] || "");
        const nextNumberBelongsToUnit = UNIT_TOKENS.has(afterNext) && !afterNextHasOwnNumber;
        if (isAlphaToken(current) && next && isNumberToken(next) && !UNIT_TOKENS.has(current) && !nextNumberBelongsToUnit) {
            tokens.push({ type: "code", value: `${current}${next}` });
            index++;
            continue;
        }
        if (isCodeToken(current)) {
            tokens.push({ type: "code", value: current });
            continue;
        }
        tokens.push({ type: "word", value: current });
    }

    return tokens;
}

function canonicalizeCompoundUnits(text: string): string {
    return text
        .replace(/\bM\s*(?:3|\^3)\s*\/\s*H\b/g, " M3H ")
        .replace(/\bM3H\b/g, " M3H ")
        .replace(/\b(?:L|LT)\s*\/\s*S\b/g, " LPS ")
        .replace(/\bLPS\b/g, " LPS ")
        .replace(/\bKCAL\s*\/\s*H\b/g, " KCALH ")
        .replace(/\bKCALH\b/g, " KCALH ")
        .replace(/\bKW\b/g, " KW ")
        .replace(/\bMM\b/g, " MM ")
        .replace(/\bCM\b/g, " CM ")
        .replace(/\bDN\b/g, " DN ");
}

function isNumberToken(value: string): boolean {
    return /^\d+(?:\.\d+)?$/.test(value);
}

function isAlphaToken(value: string): boolean {
    return /^[A-Z]+$/.test(value);
}

function isCodeToken(value: string): boolean {
    return /[A-Z]/.test(value) && /\d/.test(value);
}

function parseCompactDimension(value: string): string | null {
    const numberUnit = value.match(/^(\d+(?:\.\d+)?)(DN|MM|CM|M|KW|KCALH|LPS|M3H)$/);
    if (numberUnit) {
        return `${numberUnit[1]}${numberUnit[2]}`;
    }
    const unitNumber = value.match(/^(DN)(\d+(?:\.\d+)?)$/);
    if (unitNumber) {
        return `${unitNumber[1]}${unitNumber[2]}`;
    }
    return null;
}
