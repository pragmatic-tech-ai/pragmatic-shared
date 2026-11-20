import { createHash } from 'node:crypto'
import { DecodeReason, ProtocolDecodeError } from './protocol-decode-error.js'

/**
 * Canonical JSON, the bytes a signature covers: object keys sorted by code unit at every depth, array order kept, no
 * whitespace, strings in their `JSON.stringify` form. The protocol carries no fractional numbers, so every number is a
 * safe integer and has one spelling; anything else (a float, `undefined`, a class instance) is refused.
 */
export class CanonicalJson
{
    private static readonly Root = 'message'
    private static readonly DigestAlgorithm = 'sha256'
    private static readonly DigestPrefix = 'sha256:'
    private static readonly Hex = 'hex'
    private static readonly Utf8 = 'utf8'

    public static Stringify(value: unknown): string
    {
        const C = CanonicalJson
        if (value === null || typeof value === 'boolean' || typeof value === 'string')
        {
            return JSON.stringify(value)
        }
        if (typeof value === 'number')
        {
            if (!Number.isSafeInteger(value))
            {
                throw new ProtocolDecodeError(C.Root, DecodeReason.NotCanonical)
            }
            return JSON.stringify(value)
        }
        if (Array.isArray(value))
        {
            return '[' + value.map(item => C.Stringify(item)).join(',') + ']'
        }
        if (typeof value === 'object' && C.IsPlain(value))
        {
            const record = value as Record<string, unknown>
            return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + C.Stringify(record[key])).join(',') + '}'
        }
        throw new ProtocolDecodeError(C.Root, DecodeReason.NotCanonical)
    }

    public static Bytes(value: unknown): Buffer
    {
        return Buffer.from(CanonicalJson.Stringify(value), CanonicalJson.Utf8)
    }

    /** `sha256:<hex>` of the canonical bytes. */
    public static Digest(value: unknown): string
    {
        return CanonicalJson.DigestPrefix + createHash(CanonicalJson.DigestAlgorithm).update(CanonicalJson.Bytes(value)).digest(CanonicalJson.Hex)
    }

    private static IsPlain(value: object): boolean
    {
        const prototype = Object.getPrototypeOf(value)
        return prototype === Object.prototype || prototype === null
    }
}
