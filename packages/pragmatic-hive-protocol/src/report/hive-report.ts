import { ProtocolNames } from '../wire/protocol-names.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { StrictFields } from '../wire/strict-fields.js'

/** The state of one engine component (hive agent, tenant admin console, sign-in, Postgres, ...). */
export enum ComponentState
{
    Absent = 'absent',
    Installing = 'installing',
    Ready = 'ready',
    Degraded = 'degraded',
    Failed = 'failed',
    Removing = 'removing',
}

/** An environment's readiness. */
export enum EnvironmentReadiness
{
    Progressing = 'progressing',
    Ready = 'ready',
    NotReady = 'not-ready',
    Deleting = 'deleting',
}

/** Where an intent the hive received stands. */
export enum IntentProgress
{
    AwaitingApproval = 'awaiting-approval',
    Applying = 'applying',
    Applied = 'applied',
    Rejected = 'rejected',
    /** The pre-check against the hive's own configuration refused it, or applying failed. No reason travels. */
    Failed = 'failed',
    Expired = 'expired',
}

/**
 * Why an intent failed (`IntentProgress.Failed` only): a fixed code, never text, so a report still carries nothing
 * from the hive's data or logs.
 */
export enum IntentFailure
{
    /** The pre-check against the hive's own configuration refused it (an unknown component, a level that takes none). */
    PrecheckRefused = 'precheck-refused',
    /** The environment it names does not exist. */
    EnvironmentNotFound = 'environment-not-found',
    /** An environment of that name exists already and was not created by this intent. */
    EnvironmentExists = 'environment-exists',
    /** The version it asks for is not the one the engine runs. */
    VersionUnavailable = 'version-unavailable',
    /** The change was applied but its workload never became ready; the previous state was kept. */
    NotReady = 'not-ready',
    /** The engine's console could not be reached or did not answer in time. */
    ConsoleUnavailable = 'console-unavailable',
    /** A trust-root rotation not signed by the current root, or a key rotation the platform did not acknowledge. */
    RotationRefused = 'rotation-refused',
    /** Kept on the hive but no longer valid: its signature, issuer or body failed the recheck. */
    RecheckFailed = 'recheck-failed',
    /** Applying failed otherwise. */
    ApplyFailed = 'apply-failed',
}

export interface ComponentReportJson
{
    Component: string
    State: ComponentState
    Version: string | null
}

/** One engine component: name, state, running version. */
export class ComponentReport
{
    public static readonly States: readonly ComponentState[] = Object.values(ComponentState)
    private static readonly Field = { Component: 'Component', State: 'State', Version: 'Version' } as const
    private static readonly Members: readonly string[] = Object.values(ComponentReport.Field)

    public constructor(public readonly Component: string, public readonly State: ComponentState, public readonly Version: string | null)
    {
    }

    public static Parse(value: unknown, path: string): ComponentReport
    {
        const F = ComponentReport.Field
        const fields = StrictFields.Exactly(value, ComponentReport.Members, path)
        return new ComponentReport(fields.String(F.Component, { Pattern: ProtocolNames.Component }), fields.Enum(F.State, ComponentReport.States), fields.NullableString(F.Version, { Pattern: ProtocolNames.Version }))
    }

    public ToJson(): ComponentReportJson
    {
        return { Component: this.Component, State: this.State, Version: this.Version }
    }
}

export interface EnvironmentStatusJson
{
    Name: string
    Readiness: EnvironmentReadiness
    Version: string | null
}

/** One environment: name, readiness, deployed version. Nothing else (levels design §6a). */
export class EnvironmentStatus
{
    public static readonly Readinesses: readonly EnvironmentReadiness[] = Object.values(EnvironmentReadiness)
    private static readonly Field = { Name: 'Name', Readiness: 'Readiness', Version: 'Version' } as const
    private static readonly Members: readonly string[] = Object.values(EnvironmentStatus.Field)

    public constructor(public readonly Name: string, public readonly Readiness: EnvironmentReadiness, public readonly Version: string | null)
    {
    }

    public static Parse(value: unknown, path: string): EnvironmentStatus
    {
        const F = EnvironmentStatus.Field
        const fields = StrictFields.Exactly(value, EnvironmentStatus.Members, path)
        return new EnvironmentStatus(fields.String(F.Name, { Max: 63, Pattern: ProtocolNames.Label }), fields.Enum(F.Readiness, EnvironmentStatus.Readinesses), fields.NullableString(F.Version, { Pattern: ProtocolNames.Version }))
    }

    public ToJson(): EnvironmentStatusJson
    {
        return { Name: this.Name, Readiness: this.Readiness, Version: this.Version }
    }
}

export interface IntentStatusJson
{
    IntentId: string
    Progress: IntentProgress
    Failure: IntentFailure | null
}

/** One received intent's progress, and for a failed one its failure code (only then). */
export class IntentStatus
{
    public static readonly Progresses: readonly IntentProgress[] = Object.values(IntentProgress)
    public static readonly Failures: readonly IntentFailure[] = Object.values(IntentFailure)
    private static readonly Field = { IntentId: 'IntentId', Progress: 'Progress', Failure: 'Failure' } as const
    private static readonly Members: readonly string[] = Object.values(IntentStatus.Field)

    private constructor(public readonly IntentId: string, public readonly Progress: IntentProgress, public readonly Failure: IntentFailure | null)
    {
    }

    /** Progress other than Failed. */
    public static Of(intentId: string, progress: IntentProgress): IntentStatus
    {
        return IntentStatus.Parse({ IntentId: intentId, Progress: progress, Failure: null }, StrictFields.Root)
    }

    /** A failed intent and why. */
    public static FailedWith(intentId: string, failure: IntentFailure): IntentStatus
    {
        return IntentStatus.Parse({ IntentId: intentId, Progress: IntentProgress.Failed, Failure: failure }, StrictFields.Root)
    }

    public static Parse(value: unknown, path: string): IntentStatus
    {
        const F = IntentStatus.Field
        const fields = StrictFields.Exactly(value, IntentStatus.Members, path)
        const intentId = fields.String(F.IntentId, { Max: 63, Pattern: ProtocolNames.Label })
        const progress = fields.Enum(F.Progress, IntentStatus.Progresses)
        const failure = fields.NullableEnum(F.Failure, IntentStatus.Failures)
        if ((failure !== null) !== (progress === IntentProgress.Failed))
        {
            throw fields.Refuse(F.Failure, DecodeReason.Inconsistent)
        }
        return new IntentStatus(intentId, progress, failure)
    }

    public ToJson(): IntentStatusJson
    {
        return { IntentId: this.IntentId, Progress: this.Progress, Failure: this.Failure }
    }
}

export interface HiveReportJson
{
    EngineVersion: string
    Components: ComponentReportJson[]
    Environments: EnvironmentStatusJson[]
    Intents: IntentStatusJson[]
}

export interface HiveReportOptions
{
    EngineVersion: string
    Components: readonly ComponentReport[]
    Environments: readonly EnvironmentStatus[]
    Intents: readonly IntentStatus[]
}

/**
 * What a hive tells the platform (`MessageKind.HiveReport`, signed by the hive key): its engine components' states,
 * per environment its name, readiness and deployed version, and the progress of the intents it received. The shape
 * is closed and every member is an enum, a pattern-bound name or a version, so a report cannot carry a log line,
 * error text or anything from an environment's data.
 */
export class HiveReport
{
    public static readonly MaxComponents = 32
    public static readonly MaxEnvironments = 500
    public static readonly MaxIntents = 200
    private static readonly Field = { EngineVersion: 'EngineVersion', Components: 'Components', Environments: 'Environments', Intents: 'Intents' } as const
    private static readonly Members: readonly string[] = Object.values(HiveReport.Field)

    private constructor(
        public readonly EngineVersion: string,
        public readonly Components: readonly ComponentReport[],
        public readonly Environments: readonly EnvironmentStatus[],
        public readonly Intents: readonly IntentStatus[])
    {
    }

    public static Create(options: HiveReportOptions): HiveReport
    {
        return HiveReport.Parse({
            EngineVersion: options.EngineVersion,
            Components: options.Components.map(entry => entry.ToJson()),
            Environments: options.Environments.map(entry => entry.ToJson()),
            Intents: options.Intents.map(entry => entry.ToJson()),
        })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HiveReport
    {
        const H = HiveReport
        const F = H.Field
        const fields = StrictFields.Exactly(value, H.Members, path)
        return new HiveReport(
            fields.String(F.EngineVersion, { Pattern: ProtocolNames.Version }),
            fields.UniqueArray(F.Components, H.MaxComponents, (raw, at) => ComponentReport.Parse(raw, at), entry => entry.Component),
            fields.UniqueArray(F.Environments, H.MaxEnvironments, (raw, at) => EnvironmentStatus.Parse(raw, at), entry => entry.Name),
            fields.UniqueArray(F.Intents, H.MaxIntents, (raw, at) => IntentStatus.Parse(raw, at), entry => entry.IntentId))
    }

    public ToJson(): HiveReportJson
    {
        return {
            EngineVersion: this.EngineVersion,
            Components: this.Components.map(entry => entry.ToJson()),
            Environments: this.Environments.map(entry => entry.ToJson()),
            Intents: this.Intents.map(entry => entry.ToJson()),
        }
    }
}
