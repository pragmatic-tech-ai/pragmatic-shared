import { StrictFields } from '../wire/strict-fields.js'
import { SignedEnvelope, type SignedEnvelopeJson } from '../envelope/signed-envelope.js'

/**
 * An agent's poll (`MessageKind.Pull`, signed by the hive or host key): "what is there for me after cursor `After`",
 * at most `Max` items. A hive pulls intents, a host agent placements.
 */
export class Pull
{
    public static readonly MaxItems = 100
    private static readonly Field = { After: 'After', Max: 'Max' } as const
    private static readonly Members: readonly string[] = Object.values(Pull.Field)

    private constructor(public readonly After: number, public readonly Max: number)
    {
    }

    public static Create(after: number, max: number = Pull.MaxItems): Pull
    {
        return Pull.Parse({ After: after, Max: max })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): Pull
    {
        const F = Pull.Field
        const fields = StrictFields.Exactly(value, Pull.Members, path)
        return new Pull(fields.Integer(F.After, { Min: 0 }), fields.Integer(F.Max, { Min: 1, Max: Pull.MaxItems }))
    }

    public ToJson(): { After: number, Max: number }
    {
        return { After: this.After, Max: this.Max }
    }
}

/**
 * The platform's answer to a pull (`MessageKind.PullBatch`): the items after the cursor, each its own signed
 * envelope (an intent or a placement request, verified one by one, kept and rechecked on its own), and the cursor to
 * pull after next.
 */
export class PullBatch
{
    private static readonly Field = { Items: 'Items', Cursor: 'Cursor' } as const
    private static readonly Members: readonly string[] = Object.values(PullBatch.Field)

    private constructor(public readonly Items: readonly SignedEnvelope[], public readonly Cursor: number)
    {
    }

    public static Create(items: readonly SignedEnvelope[], cursor: number): PullBatch
    {
        return PullBatch.Parse({ Items: items.map(item => item.ToJson()), Cursor: cursor })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): PullBatch
    {
        const F = PullBatch.Field
        const fields = StrictFields.Exactly(value, PullBatch.Members, path)
        return new PullBatch(
            fields.UniqueArray(F.Items, Pull.MaxItems, (raw, at) => SignedEnvelope.Parse(raw, at), item => item.Nonce),
            fields.Integer(F.Cursor, { Min: 0 }))
    }

    public ToJson(): { Items: SignedEnvelopeJson[], Cursor: number }
    {
        return { Items: this.Items.map(item => item.ToJson()), Cursor: this.Cursor }
    }
}
