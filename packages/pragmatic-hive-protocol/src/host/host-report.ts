import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'

/** A hosting machine's health as its host agent sees it. */
export enum HostHealth
{
    Healthy = 'healthy',
    Degraded = 'degraded',
    /** Running, but taking no new placements (maintenance, out of disk). */
    Unavailable = 'unavailable',
}

/** Where one placement on the machine stands. */
export enum PlacementState
{
    CreatingCluster = 'creating-cluster',
    InstallingEngine = 'installing-engine',
    Enrolling = 'enrolling',
    Running = 'running',
    Failed = 'failed',
    Removing = 'removing',
}

export interface ResourcesJson
{
    CpuMillicores: number
    MemoryMiB: number
    StorageGiB: number
}

/** An amount of machine resources, in whole units. */
export class Resources
{
    private static readonly Field = { CpuMillicores: 'CpuMillicores', MemoryMiB: 'MemoryMiB', StorageGiB: 'StorageGiB' } as const
    private static readonly Members: readonly string[] = Object.values(Resources.Field)

    public constructor(public readonly CpuMillicores: number, public readonly MemoryMiB: number, public readonly StorageGiB: number)
    {
    }

    public static Parse(value: unknown, path: string): Resources
    {
        const F = Resources.Field
        const fields = StrictFields.Exactly(value, Resources.Members, path)
        return new Resources(fields.Integer(F.CpuMillicores, { Min: 0 }), fields.Integer(F.MemoryMiB, { Min: 0 }), fields.Integer(F.StorageGiB, { Min: 0 }))
    }

    /** Whether every amount is at most the other's. */
    public Within(other: Resources): boolean
    {
        return this.CpuMillicores <= other.CpuMillicores && this.MemoryMiB <= other.MemoryMiB && this.StorageGiB <= other.StorageGiB
    }

    public ToJson(): ResourcesJson
    {
        return { CpuMillicores: this.CpuMillicores, MemoryMiB: this.MemoryMiB, StorageGiB: this.StorageGiB }
    }
}

export interface PlacementStatusJson
{
    PlacementId: string
    State: PlacementState
}

export class PlacementStatus
{
    public static readonly States: readonly PlacementState[] = Object.values(PlacementState)
    private static readonly Field = { PlacementId: 'PlacementId', State: 'State' } as const
    private static readonly Members: readonly string[] = Object.values(PlacementStatus.Field)

    public constructor(public readonly PlacementId: string, public readonly State: PlacementState)
    {
    }

    public static Parse(value: unknown, path: string): PlacementStatus
    {
        const F = PlacementStatus.Field
        const fields = StrictFields.Exactly(value, PlacementStatus.Members, path)
        return new PlacementStatus(fields.String(F.PlacementId, { Max: 63, Pattern: ProtocolNames.Label }), fields.Enum(F.State, PlacementStatus.States))
    }

    public ToJson(): PlacementStatusJson
    {
        return { PlacementId: this.PlacementId, State: this.State }
    }
}

export interface HostReportJson
{
    AgentVersion: string
    Health: HostHealth
    Capacity: ResourcesJson
    Allocatable: ResourcesJson
    HiveSlots: number
    Placements: PlacementStatusJson[]
}

export interface HostReportOptions
{
    AgentVersion: string
    Health: HostHealth
    Capacity: Resources
    Allocatable: Resources
    HiveSlots: number
    Placements: readonly PlacementStatus[]
}

/**
 * A host agent's capacity and health report (`MessageKind.HostReport`): total and still-allocatable resources, how
 * many hives the machine can hold, and its placements' states. Placement (which machine hosts which hive) is the
 * platform's decision from these numbers. Closed shape, numbers and enums only.
 */
export class HostReport
{
    public static readonly MaxPlacements = 64
    public static readonly Healths: readonly HostHealth[] = Object.values(HostHealth)
    private static readonly Field = { AgentVersion: 'AgentVersion', Health: 'Health', Capacity: 'Capacity', Allocatable: 'Allocatable', HiveSlots: 'HiveSlots', Placements: 'Placements' } as const
    private static readonly Members: readonly string[] = Object.values(HostReport.Field)

    private constructor(
        public readonly AgentVersion: string,
        public readonly Health: HostHealth,
        public readonly Capacity: Resources,
        public readonly Allocatable: Resources,
        public readonly HiveSlots: number,
        public readonly Placements: readonly PlacementStatus[])
    {
    }

    public static Create(options: HostReportOptions): HostReport
    {
        return HostReport.Parse({
            ...options,
            Capacity: options.Capacity.ToJson(),
            Allocatable: options.Allocatable.ToJson(),
            Placements: options.Placements.map(entry => entry.ToJson()),
        })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HostReport
    {
        const H = HostReport
        const F = H.Field
        const fields = StrictFields.Exactly(value, H.Members, path)
        const report = new HostReport(
            fields.String(F.AgentVersion, { Pattern: ProtocolNames.Version }),
            fields.Enum(F.Health, H.Healths),
            fields.Read(F.Capacity, (raw, at) => Resources.Parse(raw, at)),
            fields.Read(F.Allocatable, (raw, at) => Resources.Parse(raw, at)),
            fields.Integer(F.HiveSlots, { Min: 0, Max: H.MaxPlacements }),
            fields.UniqueArray(F.Placements, H.MaxPlacements, (raw, at) => PlacementStatus.Parse(raw, at), entry => entry.PlacementId))
        if (!report.Allocatable.Within(report.Capacity))
        {
            throw fields.Refuse(F.Allocatable, DecodeReason.Inconsistent)
        }
        return report
    }

    public ToJson(): HostReportJson
    {
        return {
            AgentVersion: this.AgentVersion,
            Health: this.Health,
            Capacity: this.Capacity.ToJson(),
            Allocatable: this.Allocatable.ToJson(),
            HiveSlots: this.HiveSlots,
            Placements: this.Placements.map(entry => entry.ToJson()),
        }
    }
}
