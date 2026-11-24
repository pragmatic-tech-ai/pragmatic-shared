import { BadRequestProblem, JsonFields } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerIds } from './customer-ids.js'

/** How much the platform reaches into a hive (hive management levels design §4). */
export enum HiveLevel
{
    /** Fully standalone: no enrolment, no hive record on our side. */
    Standalone = 'standalone',
    /** Enrolled: the platform announces, the customer approves. */
    Enrolled = 'enrolled',
    /** Delegated: the platform manages by intents, never reads. */
    Delegated = 'delegated',
    /** Hosted: a SaaS hive on our machines. */
    Hosted = 'hosted',
}

/** A hive's health as its reports show it. */
export enum HiveHealth
{
    /** Enrolment or placement started, no report yet. */
    Pending = 'pending',
    Healthy = 'healthy',
    Degraded = 'degraded',
    /** No report within the expected interval. */
    Unreachable = 'unreachable',
    /** The customer left: the hive is marked gone and its domains released. */
    Gone = 'gone',
}

/** The level choices and their wire values. */
export class HiveLevels
{
    public static readonly All: readonly HiveLevel[] = Object.values(HiveLevel)
    public static readonly Healths: readonly HiveHealth[] = Object.values(HiveHealth)

    /** Whether starting this level enrols a hive (and so is the gated `enrol-hive` operation). Standalone does not. */
    public static Enrols(level: HiveLevel): boolean
    {
        return level !== HiveLevel.Standalone
    }
}

/** `start-enrolment`: start bringing a hive of `Level` under the tenant. */
export class StartEnrolmentRequest
{
    private static readonly Field = { ClientId: CustomerIds.ClientIdField, TenantId: CustomerIds.TenantIdField, Level: CustomerIds.LevelField } as const
    private static readonly Members: readonly string[] = Object.values(StartEnrolmentRequest.Field)

    public constructor(public readonly ClientId: string, public readonly TenantId: string, public readonly Level: HiveLevel)
    {
    }

    public static Parse(value: unknown): StartEnrolmentRequest
    {
        const F = StartEnrolmentRequest.Field
        const fields = JsonFields.Of(value).OnlyKnown(StartEnrolmentRequest.Members)
        return new StartEnrolmentRequest(CustomerIds.ClientId(fields), fields.String(F.TenantId, { Pattern: CustomerIds.TenantIdPattern }), fields.Enum(F.Level, HiveLevels.All))
    }

    public ToJson(): { ClientId: string, TenantId: string, Level: HiveLevel }
    {
        return { ClientId: this.ClientId, TenantId: this.TenantId, Level: this.Level }
    }
}

export interface EnrolmentStartJson
{
    Level: HiveLevel
    InstallCommand: string | null
    EnrolmentCode: string | null
    ExpiresAt: string | null
    PlacementId: string | null
}

/**
 * What the customer does next, per level: Standalone, the public install command only (nothing is recorded on our
 * side); Enrolled and Delegated, the public, secret-free install command plus a short-lived enrolment code the
 * engine's console asks for at "connect this hive to Pragmatic"; Hosted, a placement id (the platform places the hive
 * on our machines, nothing to install).
 */
export class EnrolmentStart
{
    public static readonly MaxInstallCommand = 4096
    public static readonly EnrolmentCodePattern = /^[A-Za-z0-9_-]{16,128}$/
    private static readonly Field = { Level: CustomerIds.LevelField, InstallCommand: 'InstallCommand', EnrolmentCode: 'EnrolmentCode', ExpiresAt: 'ExpiresAt', PlacementId: 'PlacementId' } as const
    private static readonly Members: readonly string[] = Object.values(EnrolmentStart.Field)
    private static readonly ShapeMessage = 'body: the members present do not match the level'

    private constructor(
        public readonly Level: HiveLevel,
        public readonly InstallCommand: string | null,
        public readonly EnrolmentCode: string | null,
        public readonly ExpiresAt: Date | null,
        public readonly PlacementId: string | null)
    {
    }

    public static Standalone(installCommand: string): EnrolmentStart
    {
        return EnrolmentStart.Checked(new EnrolmentStart(HiveLevel.Standalone, installCommand, null, null, null))
    }

    /** Enrolled or Delegated. */
    public static Connected(level: HiveLevel.Enrolled | HiveLevel.Delegated, installCommand: string, enrolmentCode: string, expiresAt: Date): EnrolmentStart
    {
        return EnrolmentStart.Checked(new EnrolmentStart(level, installCommand, enrolmentCode, expiresAt, null))
    }

    public static Hosted(placementId: string): EnrolmentStart
    {
        return EnrolmentStart.Checked(new EnrolmentStart(HiveLevel.Hosted, null, null, null, placementId))
    }

    public static Parse(value: unknown): EnrolmentStart
    {
        const F = EnrolmentStart.Field
        const fields = JsonFields.Of(value).OnlyKnown(EnrolmentStart.Members)
        return EnrolmentStart.Checked(new EnrolmentStart(
            fields.Enum(F.Level, HiveLevels.All),
            fields.NullableString(F.InstallCommand, { Max: EnrolmentStart.MaxInstallCommand }),
            fields.NullableString(F.EnrolmentCode, { Pattern: EnrolmentStart.EnrolmentCodePattern }),
            fields.NullableTimestamp(F.ExpiresAt),
            fields.NullableString(F.PlacementId, { Pattern: CustomerIds.HiveIdPattern })))
    }

    public ToJson(): EnrolmentStartJson
    {
        return {
            Level: this.Level,
            InstallCommand: this.InstallCommand,
            EnrolmentCode: this.EnrolmentCode,
            ExpiresAt: this.ExpiresAt?.toISOString() ?? null,
            PlacementId: this.PlacementId,
        }
    }

    private static Checked(start: EnrolmentStart): EnrolmentStart
    {
        const install = start.InstallCommand !== null && start.InstallCommand.length > 0 && start.InstallCommand.length <= EnrolmentStart.MaxInstallCommand
        const code = start.EnrolmentCode !== null && EnrolmentStart.EnrolmentCodePattern.test(start.EnrolmentCode) && start.ExpiresAt !== null
        const noCode = start.EnrolmentCode === null && start.ExpiresAt === null
        const placement = start.PlacementId !== null && CustomerIds.HiveIdPattern.test(start.PlacementId)
        const shapes: Record<HiveLevel, boolean> = {
            [HiveLevel.Standalone]: install && noCode && start.PlacementId === null,
            [HiveLevel.Enrolled]: install && code && start.PlacementId === null,
            [HiveLevel.Delegated]: install && code && start.PlacementId === null,
            [HiveLevel.Hosted]: start.InstallCommand === null && noCode && placement,
        }
        if (!shapes[start.Level])
        {
            throw new BadRequestProblem(EnrolmentStart.ShapeMessage)
        }
        return start
    }
}

/** `list-hives`: the client's hives, of one tenant or of all. */
export class ListHivesRequest
{
    private static readonly Members: readonly string[] = [CustomerIds.ClientIdField, CustomerIds.TenantIdField]

    public constructor(public readonly ClientId: string, public readonly TenantId: string | null = null)
    {
    }

    public static Parse(value: unknown): ListHivesRequest
    {
        const fields = JsonFields.Of(value).OnlyKnown(ListHivesRequest.Members)
        return new ListHivesRequest(CustomerIds.ClientId(fields), fields.NullableString(CustomerIds.TenantIdField, { Pattern: CustomerIds.TenantIdPattern }))
    }

    public ToJson(): { ClientId: string, TenantId: string | null }
    {
        return { ClientId: this.ClientId, TenantId: this.TenantId }
    }
}

export interface EnvironmentReportJson
{
    Name: string
    Ready: boolean
    Version: string | null
}

/** What a hive may report per environment (levels design §6a): name, readiness, deployed version. Nothing else. */
export class EnvironmentReport
{
    public static readonly MaxName = 63
    public static readonly MaxVersion = 128
    private static readonly Field = { Name: 'Name', Ready: 'Ready', Version: 'Version' } as const
    private static readonly Members: readonly string[] = Object.values(EnvironmentReport.Field)

    public constructor(public readonly Name: string, public readonly Ready: boolean, public readonly Version: string | null)
    {
    }

    public static Parse(value: unknown, path?: string): EnvironmentReport
    {
        const F = EnvironmentReport.Field
        const fields = JsonFields.Of(value, path).OnlyKnown(EnvironmentReport.Members)
        return new EnvironmentReport(fields.String(F.Name, { Max: EnvironmentReport.MaxName }), fields.Boolean(F.Ready), fields.NullableString(F.Version, { Max: EnvironmentReport.MaxVersion }))
    }

    public ToJson(): EnvironmentReportJson
    {
        return { Name: this.Name, Ready: this.Ready, Version: this.Version }
    }
}

export interface HiveViewJson
{
    HiveId: string
    TenantId: string
    Level: HiveLevel
    Home: boolean
    Health: HiveHealth
    LastReportAt: string | null
    Environments: EnvironmentReportJson[]
}

/** A hive as its customer admin sees it: level, whether it is the tenant's home hive, health and the last report. */
export class HiveView
{
    public static readonly MaxEnvironments = 500
    private static readonly Field = { HiveId: CustomerIds.HiveIdField, TenantId: CustomerIds.TenantIdField, Level: CustomerIds.LevelField, Home: 'Home', Health: 'Health', LastReportAt: 'LastReportAt', Environments: 'Environments' } as const
    private static readonly Members: readonly string[] = Object.values(HiveView.Field)

    public constructor(
        public readonly HiveId: string,
        public readonly TenantId: string,
        public readonly Level: HiveLevel,
        public readonly Home: boolean,
        public readonly Health: HiveHealth,
        public readonly LastReportAt: Date | null,
        public readonly Environments: readonly EnvironmentReport[])
    {
    }

    public static Parse(value: unknown, path?: string): HiveView
    {
        const F = HiveView.Field
        const fields = JsonFields.Of(value, path).OnlyKnown(HiveView.Members)
        return new HiveView(
            fields.String(F.HiveId, { Pattern: CustomerIds.HiveIdPattern }),
            fields.String(F.TenantId, { Pattern: CustomerIds.TenantIdPattern }),
            fields.Enum(F.Level, HiveLevels.All),
            fields.Boolean(F.Home),
            fields.Enum(F.Health, HiveLevels.Healths),
            fields.NullableTimestamp(F.LastReportAt),
            fields.Array(F.Environments, HiveView.MaxEnvironments, (entry, at) => EnvironmentReport.Parse(entry, at)))
    }

    public ToJson(): HiveViewJson
    {
        return {
            HiveId: this.HiveId,
            TenantId: this.TenantId,
            Level: this.Level,
            Home: this.Home,
            Health: this.Health,
            LastReportAt: this.LastReportAt?.toISOString() ?? null,
            Environments: this.Environments.map(environment => environment.ToJson()),
        }
    }
}

/** `list-hives` answer. */
export class HiveList
{
    public static readonly MaxHives = 1000
    private static readonly HivesField = 'Hives'
    private static readonly Members: readonly string[] = [HiveList.HivesField]

    public constructor(public readonly Hives: readonly HiveView[])
    {
    }

    public static Parse(value: unknown): HiveList
    {
        const fields = JsonFields.Of(value).OnlyKnown(HiveList.Members)
        return new HiveList(fields.Array(HiveList.HivesField, HiveList.MaxHives, (entry, path) => HiveView.Parse(entry, path)))
    }

    public ToJson(): { Hives: HiveViewJson[] }
    {
        return { Hives: this.Hives.map(hive => hive.ToJson()) }
    }
}

/** What a requested environment is for (the hive protocol's EnvironmentPurpose wire values). */
export enum RequestedEnvironmentPurpose
{
    Development = 'development',
    Runtime = 'runtime',
}

/**
 * `request-environment` (C3.4): the customer admin asks the platform for an environment on one of the client's
 * Enrolled or Delegated hives. The platform records it as a signed create-environment intent the hive pulls; an
 * Enrolled hive applies it after an admin approves it in the engine's console, a Delegated one at once.
 */
export class RequestEnvironmentRequest
{
    public static readonly EnvironmentPattern = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/
    public static readonly Purposes: readonly RequestedEnvironmentPurpose[] = Object.values(RequestedEnvironmentPurpose)
    private static readonly Field = { ClientId: CustomerIds.ClientIdField, HiveId: CustomerIds.HiveIdField, Environment: 'Environment', Purpose: 'Purpose' } as const
    private static readonly Members: readonly string[] = Object.values(RequestEnvironmentRequest.Field)

    public constructor(public readonly ClientId: string, public readonly HiveId: string, public readonly Environment: string, public readonly Purpose: RequestedEnvironmentPurpose)
    {
    }

    public static Parse(value: unknown): RequestEnvironmentRequest
    {
        const F = RequestEnvironmentRequest.Field
        const fields = JsonFields.Of(value).OnlyKnown(RequestEnvironmentRequest.Members)
        return new RequestEnvironmentRequest(
            CustomerIds.ClientId(fields),
            fields.String(F.HiveId, { Pattern: CustomerIds.HiveIdPattern }),
            fields.String(F.Environment, { Pattern: RequestEnvironmentRequest.EnvironmentPattern }),
            fields.Enum(F.Purpose, RequestEnvironmentRequest.Purposes))
    }

    public ToJson(): { ClientId: string, HiveId: string, Environment: string, Purpose: RequestedEnvironmentPurpose }
    {
        return { ClientId: this.ClientId, HiveId: this.HiveId, Environment: this.Environment, Purpose: this.Purpose }
    }
}

export interface EnvironmentRequestJson
{
    IntentId: string
    HiveId: string
    Level: HiveLevel
    ExpiresAt: string
}

/** `request-environment` answer: the intent recorded for the hive, the level it was issued under, its expiry. */
export class EnvironmentRequest
{
    public static readonly IntentIdPattern = /^in[a-z2-7]{12}$/
    private static readonly Field = { IntentId: 'IntentId', HiveId: CustomerIds.HiveIdField, Level: CustomerIds.LevelField, ExpiresAt: 'ExpiresAt' } as const
    private static readonly Members: readonly string[] = Object.values(EnvironmentRequest.Field)

    public constructor(public readonly IntentId: string, public readonly HiveId: string, public readonly Level: HiveLevel, public readonly ExpiresAt: Date)
    {
    }

    public static Parse(value: unknown): EnvironmentRequest
    {
        const F = EnvironmentRequest.Field
        const fields = JsonFields.Of(value).OnlyKnown(EnvironmentRequest.Members)
        return new EnvironmentRequest(
            fields.String(F.IntentId, { Pattern: EnvironmentRequest.IntentIdPattern }),
            fields.String(F.HiveId, { Pattern: CustomerIds.HiveIdPattern }),
            fields.Enum(F.Level, HiveLevels.All),
            fields.Timestamp(F.ExpiresAt))
    }

    public ToJson(): EnvironmentRequestJson
    {
        return { IntentId: this.IntentId, HiveId: this.HiveId, Level: this.Level, ExpiresAt: this.ExpiresAt.toISOString() }
    }
}

/** `leave-hive`: the customer uninstalled; the platform marks the hive gone and releases its domains. */
export class LeaveHiveRequest
{
    private static readonly Members: readonly string[] = [CustomerIds.ClientIdField, CustomerIds.HiveIdField]

    public constructor(public readonly ClientId: string, public readonly HiveId: string)
    {
    }

    public static Parse(value: unknown): LeaveHiveRequest
    {
        const fields = JsonFields.Of(value).OnlyKnown(LeaveHiveRequest.Members)
        return new LeaveHiveRequest(CustomerIds.ClientId(fields), fields.String(CustomerIds.HiveIdField, { Pattern: CustomerIds.HiveIdPattern }))
    }

    public ToJson(): { ClientId: string, HiveId: string }
    {
        return { ClientId: this.ClientId, HiveId: this.HiveId }
    }
}
