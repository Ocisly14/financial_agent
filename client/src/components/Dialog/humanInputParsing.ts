import type { cexParamDef } from "@/types/core";

export function stringifyHumanInputValue(val: unknown): string {
    if (val === null || val === undefined) return "";
    if (Array.isArray(val)) return val.join(", ");
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
}

export function parseHumanInputValue(raw: string, type?: string): unknown {
    const t = raw.trim();
    if (type === "number") {
        if (t === "") return undefined;
        const parsed = Number(t);
        if (Number.isNaN(parsed)) {
            throw new Error(`Expected number, got "${raw}"`);
        }
        return parsed;
    }
    if (type === "boolean") {
        if (t === "") return undefined;
        const lower = t.toLowerCase();
        if (lower === "true") return true;
        if (lower === "false") return false;
        throw new Error(`Expected boolean, got "${raw}"`);
    }
    if (type === "array") {
        if (!t) return [];
        return t
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    if (type === "object") {
        if (!t) return {};
        try {
            return JSON.parse(t);
        } catch {
            throw new Error(`Expected JSON object, got "${raw}"`);
        }
    }
    return t;
}

export function isHumanInputFieldMissing(raw: string, schema?: cexParamDef): boolean {
    return schema?.required === true && raw.trim().length === 0;
}
