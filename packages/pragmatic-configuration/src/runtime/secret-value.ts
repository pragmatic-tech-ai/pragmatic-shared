/**
 * A resolved secret setting. The value is held privately and handed out only by `Reveal()`; converting it to text,
 * JSON or an inspected form (a log line, an error, a dump) yields a fixed placeholder, never the value.
 */
export class SecretValue
{
    private static readonly Redacted = '[secret]';
    private static readonly InspectSymbol = Symbol.for('nodejs.util.inspect.custom');

    readonly #value: string;

    public constructor(value: string)
    {
        this.#value = value;
        Object.defineProperty(this, SecretValue.InspectSymbol, { value: SecretValue.Placeholder, enumerable: false });
        Object.freeze(this);
    }

    /** The secret itself: hand it straight to the code that needs it, never to a log. */
    public Reveal(): string
    {
        return this.#value;
    }

    public toString(): string
    {
        return SecretValue.Redacted;
    }

    public toJSON(): string
    {
        return SecretValue.Redacted;
    }

    private static Placeholder(): string
    {
        return SecretValue.Redacted;
    }
}
