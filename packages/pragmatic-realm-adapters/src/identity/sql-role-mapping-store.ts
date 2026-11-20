import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { RealmRole, RoleMapping, RoleMember } from '@pragmatic-tech-ai/pragmatic-identity'
import type { IRoleMappingStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlRoleMappingMigrations } from './sql-identity-migrations.js'

/** Postgres-backed role mappings: one row per (realm, role, member), the primary key making each mapping a set member.
 *  A row whose role or member no longer parses is skipped on read (it grants nothing), never coerced. */
export class SqlRoleMappingStore implements IRoleMappingStore
{
    private static readonly Table = 'identity_role_mappings'
    private static readonly Columns = 'role, member_kind, member_source, member_value'
    private static readonly MemberMatch = 'realm_id = $1 AND role = $2 AND member_kind = $3 AND member_source = $4 AND member_value = $5'

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlRoleMappingStore>
    {
        await SqlMigrationRunner.Run(session, new SqlRoleMappingMigrations())
        return new SqlRoleMappingStore(session)
    }

    public async MappingsFor(realmId: string): Promise<readonly RoleMapping[]>
    {
        const rows = await this.session.Query(`SELECT ${SqlRoleMappingStore.Columns} FROM ${SqlRoleMappingStore.Table} WHERE realm_id = $1`, [realmId])
        const mappings: RoleMapping[] = []
        for (const row of rows)
        {
            const mapping = SqlRoleMappingStore.ToMapping(row)
            if (mapping !== null)
            {
                mappings.push(mapping)
            }
        }
        return RoleMapping.Sorted(mappings)
    }

    public async Add(realmId: string, mapping: RoleMapping): Promise<boolean>
    {
        const added = await this.session.Execute(`INSERT INTO ${SqlRoleMappingStore.Table} (realm_id, ${SqlRoleMappingStore.Columns}) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, SqlRoleMappingStore.Params(realmId, mapping))
        return added > 0
    }

    public async Remove(realmId: string, mapping: RoleMapping): Promise<boolean>
    {
        const removed = await this.session.Execute(`DELETE FROM ${SqlRoleMappingStore.Table} WHERE ${SqlRoleMappingStore.MemberMatch}`, SqlRoleMappingStore.Params(realmId, mapping))
        return removed > 0
    }

    private static Params(realmId: string, mapping: RoleMapping): unknown[]
    {
        return [realmId, mapping.Role.ToString(), mapping.Member.Kind, mapping.Member.Source, mapping.Member.Value]
    }

    private static ToMapping(row: SqlRow): RoleMapping | null
    {
        const role = RealmRole.TryParse(String(row.role))
        const member = RoleMember.From(String(row.member_kind), String(row.member_source), String(row.member_value))
        return role === null || member === null ? null : new RoleMapping(role, member)
    }
}
