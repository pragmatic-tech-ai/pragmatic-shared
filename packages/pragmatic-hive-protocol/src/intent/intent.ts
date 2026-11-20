import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import { HiveLevel, HiveLevels } from '../hive/hive-level.js'
import { IntentActions, type IntentAction } from './intent-action.js'

export interface IntentJson
{
    IntentId: string
    Level: HiveLevel
    Action: Record<string, unknown>
}

/**
 * One platform intent for one hive (`MessageKind.Intent`, signed by the platform, addressed to the hive; its envelope
 * carries issued-at and expiry). `Level` is the level the platform issued it under: Enrolled means it waits for the
 * customer's approval, Delegated that the agent applies it directly.
 */
export class Intent
{
    private static readonly Field = { IntentId: 'IntentId', Level: 'Level', Action: 'Action' } as const
    private static readonly Members: readonly string[] = Object.values(Intent.Field)

    private constructor(public readonly IntentId: string, public readonly Level: HiveLevel, public readonly Action: IntentAction)
    {
    }

    public static Create(intentId: string, level: HiveLevel, action: IntentAction): Intent
    {
        return Intent.Parse({ IntentId: intentId, Level: level, Action: action.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): Intent
    {
        const F = Intent.Field
        const fields = StrictFields.Exactly(value, Intent.Members, path)
        return new Intent(
            fields.String(F.IntentId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.Enum(F.Level, HiveLevels.Pulling),
            fields.Read(F.Action, (raw, at) => IntentActions.Parse(raw, at)))
    }

    /** As issued: Enrolled intents wait for approval. The hive's own level may still be stricter (IntentAdmission). */
    public get RequiresApproval(): boolean
    {
        return this.Level === HiveLevel.Enrolled
    }

    public ToJson(): IntentJson
    {
        return { IntentId: this.IntentId, Level: this.Level, Action: this.Action.ToJson() }
    }
}

/** What the agent does with a verified intent. */
export enum IntentApplyMode
{
    /** Queue it in the tenant admin console until a realm subject approves or rejects it. */
    AwaitApproval = 'await-approval',
    /** Pre-check against the hive's own configuration and apply. */
    ApplyDirectly = 'apply-directly',
}

/** An intent for a hive that is not managed by intents (Standalone never enrols; Hosted is managed by push). */
export class IntentNotAcceptedError extends Error
{
    private static readonly ErrorName = 'IntentNotAcceptedError'
    private static readonly Text = 'This hive is not managed by pulled intents at its level.'

    public constructor()
    {
        super(IntentNotAcceptedError.Text)
        this.name = IntentNotAcceptedError.ErrorName
    }
}

/**
 * The hive-side level rule. The hive's own level (the customer switches it in the engine's console at any time) and
 * the level the intent was issued under must both be Delegated for the agent to apply it directly; otherwise it waits
 * for approval. The stricter level always wins, so a platform that still thinks a hive is Delegated cannot skip an
 * approval the customer asked for.
 */
export class IntentAdmission
{
    public constructor(public readonly HiveLevel: HiveLevel)
    {
    }

    public ModeFor(intent: Intent): IntentApplyMode
    {
        if (!HiveLevels.Pulling.includes(this.HiveLevel))
        {
            throw new IntentNotAcceptedError()
        }
        return this.HiveLevel === HiveLevel.Delegated && intent.Level === HiveLevel.Delegated ? IntentApplyMode.ApplyDirectly : IntentApplyMode.AwaitApproval
    }
}
