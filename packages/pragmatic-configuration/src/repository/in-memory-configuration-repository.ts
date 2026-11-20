import { ApplyOutcome, ApplyRecord } from './apply-record.js';
import type { ApplyRequest, ApplyTarget } from './apply-record.js';
import { ConfigurationAuthoring } from './configuration-authoring.js';
import { SystemConfigurationClock } from './configuration-clock.js';
import type { IConfigurationClock } from './configuration-clock.js';
import type { IConfigurationRepository } from './configuration-repository.js';
import { ApplyRecordNotFoundError, ConfigurationVersionNotFoundError } from './configuration-repository-errors.js';
import type { ConfigurationSaveRequest } from './configuration-save-request.js';
import type { ConfigurationScope } from './configuration-scope.js';
import type { ConfigurationVersion } from './configuration-version.js';

/** One scope's history in memory. */
class ScopeHistory
{
    public readonly Versions: ConfigurationVersion[] = [];
    public readonly Applies: ApplyRecord[] = [];

    public constructor(public readonly Scope: ConfigurationScope)
    {
    }
}

/** The configuration repository in process memory (tests, a Standalone console without Postgres). Versions and records
 *  are immutable objects, so handing them out shares nothing mutable. */
export class InMemoryConfigurationRepository implements IConfigurationRepository
{
    private readonly histories = new Map<string, ScopeHistory>();

    public constructor(private readonly clock: IConfigurationClock = new SystemConfigurationClock())
    {
    }

    public Save(request: ConfigurationSaveRequest): Promise<ConfigurationVersion>
    {
        return this.Run(() =>
        {
            const history = this.History(request.Scope);
            const version = ConfigurationAuthoring.Prepare(request, history.Versions.length, this.clock.Now());
            history.Versions.push(version);
            return version;
        });
    }

    public Head(scope: ConfigurationScope): Promise<ConfigurationVersion | null>
    {
        return Promise.resolve(this.Existing(scope)?.Versions.at(-1) ?? null);
    }

    public Version(scope: ConfigurationScope, version: number): Promise<ConfigurationVersion | null>
    {
        return Promise.resolve(this.Existing(scope)?.Versions.find(item => item.Number === version) ?? null);
    }

    public Versions(scope: ConfigurationScope): Promise<readonly ConfigurationVersion[]>
    {
        return Promise.resolve([...this.Existing(scope)?.Versions ?? []]);
    }

    public Components(realm: string): Promise<readonly string[]>
    {
        const components = [...this.histories.values()]
            .filter(history => history.Scope.Realm === realm && history.Versions.length > 0)
            .map(history => history.Scope.Component)
            .sort();
        return Promise.resolve(components);
    }

    public BeginApply(request: ApplyRequest): Promise<ApplyRecord>
    {
        return this.Run(() =>
        {
            ConfigurationAuthoring.CheckApply(request);
            const history = this.History(request.Scope);
            if (!history.Versions.some(version => version.Number === request.Version))
            {
                throw new ConfigurationVersionNotFoundError(request.Scope, request.Version);
            }
            const record = new ApplyRecord(request.Scope, history.Applies.length + 1, request.Version, request.Target, request.RequestedBy, this.clock.Now(), ApplyOutcome.Pending, undefined, '');
            history.Applies.push(record);
            return record;
        });
    }

    public CompleteApply(scope: ConfigurationScope, id: number, outcome: ApplyOutcome, detail: string): Promise<ApplyRecord>
    {
        return this.Run(() =>
        {
            const applies = this.Existing(scope)?.Applies ?? [];
            const index = applies.findIndex(record => record.Id === id);
            if (index < 0) throw new ApplyRecordNotFoundError(scope, id);
            const completed = ConfigurationAuthoring.Complete(applies[index], outcome, this.clock.Now(), detail);
            applies[index] = completed;
            return completed;
        });
    }

    public Applies(scope: ConfigurationScope): Promise<readonly ApplyRecord[]>
    {
        return Promise.resolve([...this.Existing(scope)?.Applies ?? []]);
    }

    public Applied(scope: ConfigurationScope, target: ApplyTarget): Promise<ApplyRecord | null>
    {
        const applies = this.Existing(scope)?.Applies ?? [];
        const applied = applies.filter(record => record.Outcome === ApplyOutcome.Applied && record.Target.Equals(target)).at(-1);
        return Promise.resolve(applied ?? null);
    }

    private Existing(scope: ConfigurationScope): ScopeHistory | undefined
    {
        return this.histories.get(scope.Key());
    }

    private History(scope: ConfigurationScope): ScopeHistory
    {
        let history = this.histories.get(scope.Key());
        if (history === undefined)
        {
            history = new ScopeHistory(scope);
            this.histories.set(scope.Key(), history);
        }
        return history;
    }

    /** Runs synchronous work as a promise, so a thrown rule becomes a rejection like the SQL repository's. */
    private Run<T>(work: () => T): Promise<T>
    {
        try
        {
            return Promise.resolve(work());
        }
        catch (error)
        {
            return Promise.reject(error);
        }
    }
}
