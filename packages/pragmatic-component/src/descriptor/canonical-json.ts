import { createHash } from 'node:crypto';

/** A JSON value as the descriptor and configuration documents carry it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON: object keys sorted by code unit at every depth, array order kept, no whitespace, numbers and strings
 * in their `JSON.stringify` form. The same value always yields the same text, so its digest is reproducible.
 */
export class CanonicalJson
{
    private static readonly DigestAlgorithm = 'sha256';
    private static readonly DigestPrefix = 'sha256:';
    private static readonly DigestEncoding = 'hex';
    private static readonly NotRepresentable = 'value is not representable as canonical JSON';

    public static Stringify(value: unknown): string
    {
        if (value === null) return 'null';
        if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
        if (typeof value === 'number')
        {
            if (!Number.isFinite(value)) throw new Error(`${CanonicalJson.NotRepresentable}: ${value}`);
            return JSON.stringify(value);
        }
        if (Array.isArray(value))
        {
            return `[${value.map(item => CanonicalJson.Stringify(item)).join(',')}]`;
        }
        if (typeof value === 'object' && CanonicalJson.IsPlain(value))
        {
            const record = value as Record<string, unknown>;
            const members = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${CanonicalJson.Stringify(record[key])}`);
            return `{${members.join(',')}}`;
        }
        throw new Error(`${CanonicalJson.NotRepresentable}: ${typeof value}`);
    }

    /** `sha256:<hex>` of the canonical text (UTF-8). */
    public static Digest(value: unknown): string
    {
        const hash = createHash(CanonicalJson.DigestAlgorithm).update(CanonicalJson.Stringify(value), 'utf8');
        return CanonicalJson.DigestPrefix + hash.digest(CanonicalJson.DigestEncoding);
    }

    private static IsPlain(value: object): boolean
    {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }
}
