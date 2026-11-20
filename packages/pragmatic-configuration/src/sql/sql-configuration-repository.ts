import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl';
import type { JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters';
import { ApplyOutcome, ApplyRecord, ApplyTarget } from '../repository/apply-record.js';
import type { ApplyRequest } from '../repository/apply-record.js';
import { ConfigurationAuthoring } from '../repository/configuration-authoring.js';
import { SystemConfigurationClock } from '../repository/configuration-clock.js';
import type { IConfigurationClock } from '../repository/configuration-clock.js';
import type { IConfigurationRepository } from '../repository/configuration-repository.js';
import { ApplyRecordNotFoundError, ConfigurationHeadMovedError, ConfigurationVersionNotFoundError } from '../repository/configuration-repository-errors.js';
import type { ConfigurationSaveRequest } from '../repository/configuration-save-request.js';
import type { ConfigurationScope } from '../repository/configuration-scope.js';
import { ConfigurationVersion } from '../repository/configuration-version.js';

/** The repository's two tables: configuration versions (one row per realm, component, version) and apply records. */
export class SqlConfigurationMigrations extends SqlMigrationModule
{
    public readonly Name = 'configuration.repository';

    public Migrations(): readonly SqlMigration[]
    {
        return [
            new SqlMigration(1, [
                'CREATE TABLE configuration_versions (realm_id text NOT NULL, component text NOT NULL, version integer NOT NULL, document jsonb NOT NULL, component_version text NOT NULL, descriptor_digest text NOT NULL, author text NOT NULL, created_at timestamptz NOT NULL, comment text NOT NULL, PRIMARY KEY (realm_id, component, version))',
                'CREATE TABLE configuration_applies (realm_id text NOT NULL, component text NOT NULL, apply_id integer NOT NULL, version integer NOT NULL, hive text NOT NULL, namespace text NOT NULL, deployment text NOT NULL, requested_by text NOT NULL, requested_at timestamptz NOT NULL, outcome text NOT NULL, completed_at timestamptz, detail text NOT NULL, PRIMARY KEY (realm_id, component, apply_id))',
            ]),
        ];
    }
}

/**
 * The configuration repository in the tenant admin console's Postgres. A save reads the head and inserts head + 1 in one
 * transaction; the primary key turns a concurrent save on the same head into ConfigurationHeadMovedError (optimistic
 * concurrency, no locks held across the caller's edit). Apply ids are allocated the same way and retried on a clash.
 * The session must support transactions.
 */
export class SqlConfigurationRepository implements IConfigurationRepository
{
    private static readonly UniqueViolation = '23505';
    private static readonly MaxApplyAttempts = 16;
    private static readonly NoTransactions = 'SqlConfigurationRepository needs a session with transactions';
    private static readonly ApplyContention = 'apply ids clashed on every attempt';
    private static readonly VersionColumns = 'version, document, component_version, descriptor_digest, author, created_at, comment';
    private static readonly ApplyColumns = 'apply_id, version, hive, namespace, deployment, requested_by, requested_at, outcome, completed_at, detail';
    private static readonly ScopeMatch = 'realm_id = $1 AND component = $2';
    private static readonly HeadSql = `SELECT COALESCE(MAX(version), 0) AS head FROM configuration_versions WHERE ${SqlConfigurationRepository.ScopeMatch}`;
    private static readonly InsertVersionSql = `INSERT INTO configuration_versions (realm_id, component, ${SqlConfigurationRepository.VersionColumns}) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`;
    private static readonly VersionsSql = `SELECT ${SqlConfigurationRepository.VersionColumns} FROM configuration_versions WHERE ${SqlConfigurationRepository.ScopeMatch} ORDER BY version`;
    private static readonly VersionSql = `SELECT ${SqlConfigurationRepository.VersionColumns} FROM configuration_versions WHERE ${SqlConfigurationRepository.ScopeMatch} AND version = $3`;
    private static readonly HeadVersionSql = `SELECT ${SqlConfigurationRepository.VersionColumns} FROM configuration_versions WHERE ${SqlConfigurationRepository.ScopeMatch} ORDER BY version DESC LIMIT 1`;
    private static readonly ComponentsSql = 'SELECT DISTINCT component FROM configuration_versions WHERE realm_id = $1 ORDER BY component';
    private static readonly ApplyHeadSql = `SELECT COALESCE(MAX(apply_id), 0) AS head FROM configuration_applies WHERE ${SqlConfigurationRepository.ScopeMatch}`;
    private static readonly InsertApplySql = `INSERT INTO configuration_applies (realm_id, component, ${SqlConfigurationRepository.ApplyColumns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;
    private static readonly AppliesSql = `SELECT ${SqlConfigurationRepository.ApplyColumns} FROM configuration_applies WHERE ${SqlConfigurationRepository.ScopeMatch} ORDER BY apply_id`;
    private static readonly ApplySql = `SELECT ${SqlConfigurationRepository.ApplyColumns} FROM configuration_applies WHERE ${SqlConfigurationRepository.ScopeMatch} AND apply_id = $3`;
    private static readonly CompleteSql = `UPDATE configuration_applies SET outcome = $4, completed_at = $5, detail = $6 WHERE ${SqlConfigurationRepository.ScopeMatch} AND apply_id = $3 AND outcome = $7`;
    private static readonly AppliedSql = `SELECT ${SqlConfigurationRepository.ApplyColumns} FROM configuration_applies WHERE ${SqlConfigurationRepository.ScopeMatch} AND hive = $3 AND namespace = $4 AND deployment = $5 AND outcome = $6 ORDER BY apply_id DESC LIMIT 1`;

    private constructor(private readonly session: ISqlSession, private readonly clock: IConfigurationClock)
    {
    }

    /** Migrates the tables and opens the repository. */
    public static async Open(session: ISqlSession, clock: IConfigurationClock = new SystemConfigurationClock()): Promise<SqlConfigurationRepository>
    {
        if (session.Transaction === undefined) throw new Error(SqlConfigurationRepository.NoTransactions);
        await SqlMigrationRunner.Run(session, new SqlConfigurationMigrations());
        return new SqlConfigurationRepository(session, clock);
    }

    public async Save(request: ConfigurationSaveRequest): Promise<ConfigurationVersion>
    {
        const scope = request.Scope;
        try
        {
            return await this.Transaction(async tx =>
            {
                const head = SqlConfigurationRepository.HeadOf(await tx.Query(SqlConfigurationRepository.HeadSql, SqlConfigurationRepository.ScopeParams(scope)));
                const version = ConfigurationAuthoring.Prepare(request, head, this.clock.Now());
                await tx.Execute(SqlConfigurationRepository.InsertVersionSql, [
                    scope.Realm, scope.Component, version.Number, JSON.stringify(version.Document), version.ComponentVersion,
                    version.DescriptorDigest, version.Author, version.CreatedAt, version.Comment,
                ]);
                return version;
            });
        }
        catch (error)
        {
            if (!SqlConfigurationRepository.IsUniqueViolation(error)) throw error;
            const head = SqlConfigurationRepository.HeadOf(await this.session.Query(SqlConfigurationRepository.HeadSql, SqlConfigurationRepository.ScopeParams(scope)));
            throw new ConfigurationHeadMovedError(scope, request.BasedOn, head);
        }
    }

    public async Head(scope: ConfigurationScope): Promise<ConfigurationVersion | null>
    {
        const rows = await this.session.Query(SqlConfigurationRepository.HeadVersionSql, SqlConfigurationRepository.ScopeParams(scope));
        return rows[0] === undefined ? null : SqlConfigurationRepository.ToVersion(scope, rows[0]);
    }

    public async Version(scope: ConfigurationScope, version: number): Promise<ConfigurationVersion | null>
    {
        const rows = await this.session.Query(SqlConfigurationRepository.VersionSql, [...SqlConfigurationRepository.ScopeParams(scope), version]);
        return rows[0] === undefined ? null : SqlConfigurationRepository.ToVersion(scope, rows[0]);
    }

    public async Versions(scope: ConfigurationScope): Promise<readonly ConfigurationVersion[]>
    {
        const rows = await this.session.Query(SqlConfigurationRepository.VersionsSql, SqlConfigurationRepository.ScopeParams(scope));
        return rows.map(row => SqlConfigurationRepository.ToVersion(scope, row));
    }

    public async Components(realm: string): Promise<readonly string[]>
    {
        const rows = await this.session.Query(SqlConfigurationRepository.ComponentsSql, [realm]);
        return rows.map(row => String(row.component));
    }

    public async BeginApply(request: ApplyRequest): Promise<ApplyRecord>
    {
        ConfigurationAuthoring.CheckApply(request);
        const scope = request.Scope;
        if (await this.Version(scope, request.Version) === null) throw new ConfigurationVersionNotFoundError(scope, request.Version);
        for (let attempt = 0; attempt < SqlConfigurationRepository.MaxApplyAttempts; attempt++)
        {
            try
            {
                return await this.Transaction(async tx =>
                {
                    const id = SqlConfigurationRepository.HeadOf(await tx.Query(SqlConfigurationRepository.ApplyHeadSql, SqlConfigurationRepository.ScopeParams(scope))) + 1;
                    const record = new ApplyRecord(scope, id, request.Version, request.Target, request.RequestedBy, this.clock.Now(), ApplyOutcome.Pending, undefined, '');
                    await tx.Execute(SqlConfigurationRepository.InsertApplySql, [
                        scope.Realm, scope.Component, record.Id, record.Version, record.Target.Hive, record.Target.Namespace,
                        record.Target.Deployment, record.RequestedBy, record.RequestedAt, record.Outcome, null, record.Detail,
                    ]);
                    return record;
                });
            }
            catch (error)
            {
                if (!SqlConfigurationRepository.IsUniqueViolation(error)) throw error;
            }
        }
        throw new Error(`${scope.Key()}: ${SqlConfigurationRepository.ApplyContention}`);
    }

    public async CompleteApply(scope: ConfigurationScope, id: number, outcome: ApplyOutcome, detail: string): Promise<ApplyRecord>
    {
        const rows = await this.session.Query(SqlConfigurationRepository.ApplySql, [...SqlConfigurationRepository.ScopeParams(scope), id]);
        if (rows[0] === undefined) throw new ApplyRecordNotFoundError(scope, id);
        const completed = ConfigurationAuthoring.Complete(SqlConfigurationRepository.ToApply(scope, rows[0]), outcome, this.clock.Now(), detail);
        const updated = await this.session.Execute(SqlConfigurationRepository.CompleteSql, [
            ...SqlConfigurationRepository.ScopeParams(scope), id, completed.Outcome, completed.CompletedAt, completed.Detail, ApplyOutcome.Pending,
        ]);
        if (updated === 0)
        {
            // Completed by someone else between the read and the update: report it as the rule does.
            const current = await this.session.Query(SqlConfigurationRepository.ApplySql, [...SqlConfigurationRepository.ScopeParams(scope), id]);
            ConfigurationAuthoring.Complete(SqlConfigurationRepository.ToApply(scope, current[0]), outcome, this.clock.Now(), detail);
        }
        return completed;
    }

    public async Applies(scope: ConfigurationScope): Promise<readonly ApplyRecord[]>
    {
        const rows = await this.session.Query(SqlConfigurationRepository.AppliesSql, SqlConfigurationRepository.ScopeParams(scope));
        return rows.map(row => SqlConfigurationRepository.ToApply(scope, row));
    }

    public async Applied(scope: ConfigurationScope, target: ApplyTarget): Promise<ApplyRecord | null>
    {
        const rows = await this.session.Query(SqlConfigurationRepository.AppliedSql, [
            ...SqlConfigurationRepository.ScopeParams(scope), target.Hive, target.Namespace, target.Deployment, ApplyOutcome.Applied,
        ]);
        return rows[0] === undefined ? null : SqlConfigurationRepository.ToApply(scope, rows[0]);
    }

    private Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        return this.session.Transaction!(work);
    }

    private static ScopeParams(scope: ConfigurationScope): unknown[]
    {
        return [scope.Realm, scope.Component];
    }

    private static HeadOf(rows: readonly SqlRow[]): number
    {
        return Number(rows[0]?.head ?? 0);
    }

    private static IsUniqueViolation(error: unknown): boolean
    {
        return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === SqlConfigurationRepository.UniqueViolation;
    }

    private static ToVersion(scope: ConfigurationScope, row: SqlRow): ConfigurationVersion
    {
        const document = typeof row.document === 'string' ? JSON.parse(row.document) : row.document;
        return new ConfigurationVersion(
            scope,
            Number(row.version),
            document as Record<string, JsonValue>,
            String(row.component_version),
            String(row.descriptor_digest),
            String(row.author),
            SqlConfigurationRepository.ToDate(row.created_at),
            String(row.comment),
        );
    }

    private static ToApply(scope: ConfigurationScope, row: SqlRow): ApplyRecord
    {
        return new ApplyRecord(
            scope,
            Number(row.apply_id),
            Number(row.version),
            new ApplyTarget(String(row.hive), String(row.namespace), String(row.deployment)),
            String(row.requested_by),
            SqlConfigurationRepository.ToDate(row.requested_at),
            String(row.outcome) as ApplyOutcome,
            row.completed_at === null || row.completed_at === undefined ? undefined : SqlConfigurationRepository.ToDate(row.completed_at),
            String(row.detail),
        );
    }

    private static ToDate(value: unknown): Date
    {
        return value instanceof Date ? value : new Date(String(value));
    }
}
