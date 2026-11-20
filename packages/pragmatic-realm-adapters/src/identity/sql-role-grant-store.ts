import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { Grant, ResourceRef } from '@pragmatic-tech-ai/pragmatic-identity'
import type { Role, ResourceKind, Realm, IRoleGrantStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlRoleGrantMigrations } from './sql-identity-migrations.js'

/** Postgres-backed role-grant store. Mirrors FileRoleGrantStore: GrantsFor filters by SUBJECT only (realm
 *  ignored), Save APPENDS with no dedup. Role and ResourceKind persist as their integer enum values; the
 *  resource path persists as a JSON array. */
export class SqlRoleGrantStore implements IRoleGrantStore
{
    private static readonly Table = 'identity_role_grants'
    private static readonly SelectColumns = 'SELECT subject, role, resource_kind, resource_realm_id, resource_path'

    private readonly session: ISqlSession

    private constructor(session: ISqlSession)
    {
        this.session = session
    }

    public static async Open(session: ISqlSession): Promise<SqlRoleGrantStore>
    {
        await SqlMigrationRunner.Run(session, new SqlRoleGrantMigrations())
        return new SqlRoleGrantStore(session)
    }

    public async GrantsFor(subject: string, _realm: Realm): Promise<readonly Grant[]>
    {
        // Grant order is not significant: GrantsFor returns an unordered bag the authorization engine scans; a serial column is intentionally avoided (plan's no-serial constraint).
        const rows = await this.session.Query(`${SqlRoleGrantStore.SelectColumns} FROM ${SqlRoleGrantStore.Table} WHERE subject = $1`, [subject])
        return rows.map(SqlRoleGrantStore.ToGrant)
    }

    /** Every grant whose resource EXACTLY matches (Kind + RealmId + element-wise Path); not prefix/cover. */
    public async GrantsOn(resource: ResourceRef): Promise<readonly Grant[]>
    {
        const rows = await this.session.Query(`${SqlRoleGrantStore.SelectColumns} FROM ${SqlRoleGrantStore.Table} WHERE resource_kind = $1 AND resource_realm_id = $2 AND resource_path = $3`, [resource.Kind, resource.RealmId, JSON.stringify([...resource.Path])])
        return rows.map(SqlRoleGrantStore.ToGrant)
    }

    public async Save(grant: Grant): Promise<void>
    {
        await this.session.Execute(`INSERT INTO ${SqlRoleGrantStore.Table} (subject, role, resource_kind, resource_realm_id, resource_path) VALUES ($1, $2, $3, $4, $5)`, [grant.Subject, grant.Role, grant.Resource.Kind, grant.Resource.RealmId, JSON.stringify([...grant.Resource.Path])])
    }

    public async Revoke(grant: Grant): Promise<void>
    {
        await this.session.Execute(`DELETE FROM ${SqlRoleGrantStore.Table} WHERE subject = $1 AND role = $2 AND resource_kind = $3 AND resource_realm_id = $4 AND resource_path = $5`, [grant.Subject, grant.Role, grant.Resource.Kind, grant.Resource.RealmId, JSON.stringify([...grant.Resource.Path])])
    }

    private static ToGrant(row: SqlRow): Grant
    {
        return new Grant(String(row.subject), Number(row.role) as Role, new ResourceRef(Number(row.resource_kind) as ResourceKind, String(row.resource_realm_id), JSON.parse(String(row.resource_path)) as string[]))
    }
}
