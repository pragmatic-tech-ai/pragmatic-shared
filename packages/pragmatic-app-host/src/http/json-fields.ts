import { BadRequestProblem } from './http-problem.js'

/** Limits on one string member. */
export interface JsonStringRule
{
    /** Default 1. */
    Min?: number
    /** Default 1024. */
    Max?: number
    Pattern?: RegExp
}

/** Limits on one integer member (always a safe integer). */
export interface JsonIntegerRule
{
    Min?: number
    Max?: number
}

/**
 * Strict reading of one JSON object: each accessor returns a member of the asked type or throws BadRequestProblem
 * (400, `invalid-request`) naming the member's path and a fixed reason, never the rejected value. `OnlyKnown` refuses
 * members nobody reads, so a typo or a newer sender's field is an error rather than silently dropped.
 */
export class JsonFields
{
    private static readonly DefaultMax = 1024
    private static readonly PathSeparator = '.'
    private static readonly ReasonSeparator = ': '
    private static readonly IndexOpen = '['
    private static readonly IndexClose = ']'
    private static readonly Root = 'body'
    private static readonly NotObject = 'must be a JSON object'
    private static readonly Missing = 'is required'
    private static readonly NotString = 'must be a string'
    private static readonly BadLength = 'has a length out of range'
    private static readonly BadFormat = 'is not in the expected format'
    private static readonly NotInteger = 'must be an integer'
    private static readonly OutOfRange = 'is out of range'
    private static readonly NotBoolean = 'must be true or false'
    private static readonly NotAllowed = 'is not one of the allowed values'
    private static readonly NotArray = 'must be an array'
    private static readonly TooMany = 'has too many entries'
    private static readonly Unknown = 'is not a known member'
    private static readonly NotTimestamp = 'must be a UTC timestamp'
    private static readonly TimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

    private constructor(private readonly value: Readonly<Record<string, unknown>>, public readonly Path: string)
    {
    }

    /** The object at `path` (default `body`), or a 400. */
    public static Of(value: unknown, path: string = JsonFields.Root): JsonFields
    {
        if (!JsonFields.IsObject(value))
        {
            throw JsonFields.Problem(path, JsonFields.NotObject)
        }
        return new JsonFields(value, path)
    }

    public static IsObject(value: unknown): value is Record<string, unknown>
    {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /** Refuses every member not in `names`. */
    public OnlyKnown(names: readonly string[]): this
    {
        for (const key of Object.keys(this.value))
        {
            if (!names.includes(key))
            {
                throw JsonFields.Problem(this.PathOf(key), JsonFields.Unknown)
            }
        }
        return this
    }

    /** Present and not null. */
    public Has(name: string): boolean
    {
        return Object.hasOwn(this.value, name) && this.value[name] !== null && this.value[name] !== undefined
    }

    public String(name: string, rule: JsonStringRule = {}): string
    {
        return JsonFields.StringValue(this.Required(name), this.PathOf(name), rule)
    }

    /** Absent or null reads as null. */
    public NullableString(name: string, rule: JsonStringRule = {}): string | null
    {
        return this.Has(name) ? this.String(name, rule) : null
    }

    /** A UTC timestamp written `YYYY-MM-DDThh:mm:ss[.sss]Z` (what Date.toISOString writes). */
    public Timestamp(name: string): Date
    {
        const path = this.PathOf(name)
        const value = this.Required(name)
        const time = typeof value === 'string' && JsonFields.TimestampPattern.test(value) ? new Date(value) : undefined
        if (time === undefined || Number.isNaN(time.getTime()))
        {
            throw JsonFields.Problem(path, JsonFields.NotTimestamp)
        }
        return time
    }

    /** Absent or null reads as null. */
    public NullableTimestamp(name: string): Date | null
    {
        return this.Has(name) ? this.Timestamp(name) : null
    }

    public Integer(name: string, rule: JsonIntegerRule = {}): number
    {
        return JsonFields.IntegerValue(this.Required(name), this.PathOf(name), rule)
    }

    public Boolean(name: string): boolean
    {
        const value = this.Required(name)
        if (typeof value !== 'boolean')
        {
            throw JsonFields.Problem(this.PathOf(name), JsonFields.NotBoolean)
        }
        return value
    }

    public Enum<T extends string>(name: string, allowed: readonly T[]): T
    {
        const value = this.Required(name)
        if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
        {
            throw JsonFields.Problem(this.PathOf(name), JsonFields.NotAllowed)
        }
        return value as T
    }

    /** Absent or null reads as `fallback`. */
    public OptionalEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T
    {
        return this.Has(name) ? this.Enum(name, allowed) : fallback
    }

    public Object(name: string): JsonFields
    {
        return JsonFields.Of(this.Required(name), this.PathOf(name))
    }

    /** Absent or null reads as null. */
    public NullableObject(name: string): JsonFields | null
    {
        return this.Has(name) ? this.Object(name) : null
    }

    /** A required member handed to `read` with its path (a nested DTO's own Parse). */
    public Read<T>(name: string, read: (value: unknown, path: string) => T): T
    {
        return read(this.Required(name), this.PathOf(name))
    }

    /** Absent or null reads as null; otherwise as Read. */
    public NullableRead<T>(name: string, read: (value: unknown, path: string) => T): T | null
    {
        return this.Has(name) ? this.Read(name, read) : null
    }

    /** The entries of an array member, each handed to `read` with its own path. */
    public Array<T>(name: string, maxEntries: number, read: (entry: unknown, path: string) => T): T[]
    {
        const value = this.Required(name)
        const path = this.PathOf(name)
        if (!Array.isArray(value))
        {
            throw JsonFields.Problem(path, JsonFields.NotArray)
        }
        if (value.length > maxEntries)
        {
            throw JsonFields.Problem(path, JsonFields.TooMany)
        }
        return value.map((entry, index) => read(entry, path + JsonFields.IndexOpen + index + JsonFields.IndexClose))
    }

    /** An object member whose keys match `keyPattern` and whose values are integers within `rule`. */
    public IntegerMap(name: string, keyPattern: RegExp, maxEntries: number, rule: JsonIntegerRule = {}): Map<string, number>
    {
        const nested = this.Object(name)
        const keys = Object.keys(nested.value)
        if (keys.length > maxEntries)
        {
            throw JsonFields.Problem(nested.Path, JsonFields.TooMany)
        }
        const map = new Map<string, number>()
        for (const key of keys)
        {
            if (!keyPattern.test(key))
            {
                throw JsonFields.Problem(nested.PathOf(key), JsonFields.BadFormat)
            }
            map.set(key, nested.Integer(key, rule))
        }
        return map
    }

    /** A string array entry or nested value checked as a string member would be. */
    public static StringAt(value: unknown, path: string, rule: JsonStringRule = {}): string
    {
        return JsonFields.StringValue(value, path, rule)
    }

    private Required(name: string): unknown
    {
        if (!this.Has(name))
        {
            throw JsonFields.Problem(this.PathOf(name), JsonFields.Missing)
        }
        return this.value[name]
    }

    private static StringValue(value: unknown, path: string, rule: JsonStringRule): string
    {
        if (typeof value !== 'string')
        {
            throw JsonFields.Problem(path, JsonFields.NotString)
        }
        if (value.length < (rule.Min ?? 1) || value.length > (rule.Max ?? JsonFields.DefaultMax))
        {
            throw JsonFields.Problem(path, JsonFields.BadLength)
        }
        if (rule.Pattern !== undefined && !rule.Pattern.test(value))
        {
            throw JsonFields.Problem(path, JsonFields.BadFormat)
        }
        return value
    }

    private static IntegerValue(value: unknown, path: string, rule: JsonIntegerRule): number
    {
        if (typeof value !== 'number' || !Number.isSafeInteger(value))
        {
            throw JsonFields.Problem(path, JsonFields.NotInteger)
        }
        if ((rule.Min !== undefined && value < rule.Min) || (rule.Max !== undefined && value > rule.Max))
        {
            throw JsonFields.Problem(path, JsonFields.OutOfRange)
        }
        return value
    }

    private PathOf(name: string): string
    {
        return this.Path + JsonFields.PathSeparator + name
    }

    private static Problem(path: string, reason: string): BadRequestProblem
    {
        return new BadRequestProblem(path + JsonFields.ReasonSeparator + reason)
    }
}
