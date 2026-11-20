import { DecodeReason, ProtocolDecodeError } from './protocol-decode-error.js'

/** Limits on one string member: a length range (default 1-256) and, almost always, a closed pattern. */
export interface StringRule
{
    Min?: number
    Max?: number
    Pattern?: RegExp
}

/** Limits on one integer member (always a safe integer). */
export interface IntegerRule
{
    Min?: number
    Max?: number
}

/**
 * Strict reading of one protocol object. The shape is closed: `Exactly` refuses any member not listed, and every
 * listed member must be present (a nullable one as `null`), so a message has one form and a newer sender's field is an
 * error, never silently dropped. Each accessor returns a member of the asked type or throws `ProtocolDecodeError`
 * naming the member's path and a fixed reason.
 */
export class StrictFields
{
    public static readonly Root = 'message'
    private static readonly DefaultMax = 256
    private static readonly PathSeparator = '.'
    private static readonly IndexOpen = '['
    private static readonly IndexClose = ']'
    private static readonly TimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

    private constructor(private readonly value: Readonly<Record<string, unknown>>, public readonly Path: string)
    {
    }

    /** The object at `path`, or a decode error. */
    public static Of(value: unknown, path: string = StrictFields.Root): StrictFields
    {
        if (!StrictFields.IsObject(value))
        {
            throw new ProtocolDecodeError(path, DecodeReason.NotObject)
        }
        return new StrictFields(value, path)
    }

    /** The object at `path`, holding exactly `names` (each present, none other). */
    public static Exactly(value: unknown, names: readonly string[], path: string = StrictFields.Root): StrictFields
    {
        const fields = StrictFields.Of(value, path)
        for (const key of Object.keys(fields.value))
        {
            if (!names.includes(key))
            {
                throw new ProtocolDecodeError(fields.PathOf(key), DecodeReason.Unknown)
            }
        }
        for (const name of names)
        {
            if (!Object.hasOwn(fields.value, name))
            {
                throw new ProtocolDecodeError(fields.PathOf(name), DecodeReason.Missing)
            }
        }
        return fields
    }

    public static IsObject(value: unknown): value is Record<string, unknown>
    {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    public String(name: string, rule: StringRule): string
    {
        return StrictFields.StringAt(this.Required(name), this.PathOf(name), rule)
    }

    public NullableString(name: string, rule: StringRule): string | null
    {
        return this.IsNull(name) ? null : this.String(name, rule)
    }

    public Integer(name: string, rule: IntegerRule = {}): number
    {
        const path = this.PathOf(name)
        const value = this.Required(name)
        if (typeof value !== 'number' || !Number.isSafeInteger(value))
        {
            throw new ProtocolDecodeError(path, DecodeReason.NotInteger)
        }
        if ((rule.Min !== undefined && value < rule.Min) || (rule.Max !== undefined && value > rule.Max))
        {
            throw new ProtocolDecodeError(path, DecodeReason.OutOfRange)
        }
        return value
    }

    public Boolean(name: string): boolean
    {
        const value = this.Required(name)
        if (typeof value !== 'boolean')
        {
            throw new ProtocolDecodeError(this.PathOf(name), DecodeReason.NotBoolean)
        }
        return value
    }

    public Enum<T extends string>(name: string, allowed: readonly T[]): T
    {
        const value = this.Required(name)
        if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
        {
            throw new ProtocolDecodeError(this.PathOf(name), DecodeReason.NotAllowed)
        }
        return value as T
    }

    public NullableEnum<T extends string>(name: string, allowed: readonly T[]): T | null
    {
        return this.IsNull(name) ? null : this.Enum(name, allowed)
    }

    /** A UTC timestamp with milliseconds, exactly as `Date.toISOString` writes it (one spelling per instant). */
    public Timestamp(name: string): Date
    {
        const path = this.PathOf(name)
        const value = this.Required(name)
        const time = typeof value === 'string' && StrictFields.TimestampPattern.test(value) ? new Date(value) : undefined
        if (time === undefined || Number.isNaN(time.getTime()) || time.toISOString() !== value)
        {
            throw new ProtocolDecodeError(path, DecodeReason.NotTimestamp)
        }
        return time
    }

    /** A required member handed to `read` with its path (a nested shape's own Parse). */
    public Read<T>(name: string, read: (value: unknown, path: string) => T): T
    {
        return read(this.Required(name), this.PathOf(name))
    }

    public NullableRead<T>(name: string, read: (value: unknown, path: string) => T): T | null
    {
        return this.IsNull(name) ? null : this.Read(name, read)
    }

    /** The entries of an array member (at most `maxEntries`), each handed to `read` with its own path. */
    public Array<T>(name: string, maxEntries: number, read: (entry: unknown, path: string) => T): T[]
    {
        const value = this.Required(name)
        const path = this.PathOf(name)
        if (!Array.isArray(value))
        {
            throw new ProtocolDecodeError(path, DecodeReason.NotArray)
        }
        if (value.length > maxEntries)
        {
            throw new ProtocolDecodeError(path, DecodeReason.TooMany)
        }
        return value.map((entry, index) => read(entry, path + StrictFields.IndexOpen + index + StrictFields.IndexClose))
    }

    /** As Array, refusing two entries with the same key. */
    public UniqueArray<T>(name: string, maxEntries: number, read: (entry: unknown, path: string) => T, key: (entry: T) => string): T[]
    {
        const entries = this.Array(name, maxEntries, read)
        if (new Set(entries.map(key)).size !== entries.length)
        {
            throw new ProtocolDecodeError(this.PathOf(name), DecodeReason.Duplicate)
        }
        return entries
    }

    /** The raw member, required and not null (an embedded object checked later by its own reader). */
    public Raw(name: string): unknown
    {
        return this.Required(name)
    }

    /** A decode error on member `name` (a cross-member rule the accessors cannot see). */
    public Refuse(name: string, reason: DecodeReason): ProtocolDecodeError
    {
        return new ProtocolDecodeError(this.PathOf(name), reason)
    }

    public PathOf(name: string): string
    {
        return this.Path + StrictFields.PathSeparator + name
    }

    /** A string entry or nested value checked as a string member would be. */
    public static StringAt(value: unknown, path: string, rule: StringRule): string
    {
        if (typeof value !== 'string')
        {
            throw new ProtocolDecodeError(path, DecodeReason.NotString)
        }
        if (value.length < (rule.Min ?? 1) || value.length > (rule.Max ?? StrictFields.DefaultMax))
        {
            throw new ProtocolDecodeError(path, DecodeReason.BadLength)
        }
        if (rule.Pattern !== undefined && !rule.Pattern.test(value))
        {
            throw new ProtocolDecodeError(path, DecodeReason.BadFormat)
        }
        return value
    }

    private IsNull(name: string): boolean
    {
        return this.value[name] === null
    }

    private Required(name: string): unknown
    {
        const value = this.value[name]
        if (!Object.hasOwn(this.value, name) || value === null || value === undefined)
        {
            throw new ProtocolDecodeError(this.PathOf(name), DecodeReason.Missing)
        }
        return value
    }
}
