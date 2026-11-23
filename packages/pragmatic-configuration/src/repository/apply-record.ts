import { ConfigurationScope } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';

/** Where an apply ended: still in progress, written next to the deployment and rolled out, or not. */
export enum ApplyOutcome
{
    Pending = 'pending',
    Applied = 'applied',
    Failed = 'failed',
}

/** The deployment a configuration version is applied to: the hive, the namespace in its cluster, the deployment. */
export class ApplyTarget
{
    private static readonly LabelPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
    private static readonly MaxLabelLength = 63;
    private static readonly KeySeparator = '/';
    private static readonly InvalidName = 'hive, namespace and deployment are DNS labels (lowercase letters, digits, "-", at most 63)';

    public constructor(
        public readonly Hive: string,
        public readonly Namespace: string,
        public readonly Deployment: string,
    )
    {
        for (const name of [Hive, Namespace, Deployment])
        {
            if (!ApplyTarget.LabelPattern.test(name) || name.length > ApplyTarget.MaxLabelLength) throw new Error(ApplyTarget.InvalidName);
        }
        Object.freeze(this);
    }

    public Key(): string
    {
        return [this.Hive, this.Namespace, this.Deployment].join(ApplyTarget.KeySeparator);
    }

    public Equals(other: ApplyTarget): boolean
    {
        return this.Key() === other.Key();
    }
}

/** A request to apply one saved version of a scope to one deployment, made by a realm subject. */
export class ApplyRequest
{
    public constructor(
        public readonly Scope: ConfigurationScope,
        public readonly Version: number,
        public readonly Target: ApplyTarget,
        public readonly RequestedBy: string,
    )
    {
        Object.freeze(this);
    }
}

/**
 * One apply of a configuration version to a deployment: its id (1, 2, ... per scope), the version, the target, who asked
 * and when, and the outcome (pending until completed once as applied or failed, with an optional detail).
 */
export class ApplyRecord
{
    public constructor(
        public readonly Scope: ConfigurationScope,
        public readonly Id: number,
        public readonly Version: number,
        public readonly Target: ApplyTarget,
        public readonly RequestedBy: string,
        public readonly RequestedAt: Date,
        public readonly Outcome: ApplyOutcome,
        public readonly CompletedAt: Date | undefined,
        public readonly Detail: string,
    )
    {
        this.RequestedAt = new Date(RequestedAt.getTime());
        this.CompletedAt = CompletedAt === undefined ? undefined : new Date(CompletedAt.getTime());
        Object.freeze(this);
    }

    public Completed(outcome: ApplyOutcome, at: Date, detail: string): ApplyRecord
    {
        return new ApplyRecord(this.Scope, this.Id, this.Version, this.Target, this.RequestedBy, this.RequestedAt, outcome, at, detail);
    }
}
