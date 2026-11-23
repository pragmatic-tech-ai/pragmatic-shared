import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { IdentityConfig, SecurityModelValidator } from '@pragmatic-tech-ai/pragmatic-identity'
import type { DelegationDepth, Role, IRealmConfigStore, ISecurityModelConfig } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlRealmConfigMigrations } from './sql-identity-migrations.js'


/** Postgres-backed realm-config store. Mirrors FileRealmConfigStore: the three ReadonlyMap fields persist
 *  as JSON [key, value] arrays (GroupRoleMap values are integer Role enum values), the security model as JSON (validated
 *  on Save, and on Get, where an invalid stored model throws InvalidSecurityModelError: fail closed); Save upserts by
 *  realm id. */
export class SqlRealmConfigStore implements IRealmConfigStore
{
    private static readonly Table = 'identity_realm_config'

    private readonly session: ISqlSession

    private constructor(session: ISqlSession)
    {
        this.session = session
    }

    public static async Open(session: ISqlSession): Promise<SqlRealmConfigStore>
    {
        await SqlMigrationRunner.Run(session, new SqlRealmConfigMigrations())
        return new SqlRealmConfigStore(session)
    }

    public async Get(realmId: string): Promise<IdentityConfig | null>
    {
        const rows = await this.session.Query(`SELECT pack_id, delegation_depth, provider_settings, group_role_map, claims_mapping, security_model FROM ${SqlRealmConfigStore.Table} WHERE realm_id = $1`, [realmId])
        const row = rows[0]
        if (row === undefined)
        {
            return null
        }
        return new IdentityConfig(String(row.pack_id), Number(row.delegation_depth) as DelegationDepth, SqlRealmConfigStore.ToStringMap(row.provider_settings), SqlRealmConfigStore.ToRoleMap(row.group_role_map), SqlRealmConfigStore.ToStringMap(row.claims_mapping), SqlRealmConfigStore.ToSecurityModel(row.security_model))
    }

    public async Save(realmId: string, config: IdentityConfig): Promise<void>
    {
        if (config.SecurityModel !== undefined)
        {
            SecurityModelValidator.AssertValid(config.SecurityModel)
        }
        const model = config.SecurityModel === undefined ? null : JSON.stringify(config.SecurityModel)
        await this.session.Execute(`INSERT INTO ${SqlRealmConfigStore.Table} (realm_id, pack_id, delegation_depth, provider_settings, group_role_map, claims_mapping, security_model) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (realm_id) DO UPDATE SET pack_id = $2, delegation_depth = $3, provider_settings = $4, group_role_map = $5, claims_mapping = $6, security_model = $7`, [realmId, config.PackId, config.DelegationDepth, JSON.stringify([...config.ProviderSettings]), JSON.stringify([...config.GroupRoleMap]), JSON.stringify([...config.ClaimsMapping]), model])
    }

    public async List(): Promise<readonly string[]>
    {
        const rows = await this.session.Query(`SELECT realm_id FROM ${SqlRealmConfigStore.Table}`, [])
        return rows.map(row => String(row.realm_id))
    }

    private static ToStringMap(value: unknown): ReadonlyMap<string, string>
    {
        return new Map(JSON.parse(String(value)) as Array<[string, string]>)
    }

    /** The stored security model, validated (an invalid one throws: a realm never runs on a model it cannot trust). */
    private static ToSecurityModel(value: unknown): ISecurityModelConfig | undefined
    {
        if (value === null || value === undefined)
        {
            return undefined
        }
        const model = JSON.parse(String(value)) as ISecurityModelConfig
        SecurityModelValidator.AssertValid(model)
        return model
    }

    private static ToRoleMap(value: unknown): ReadonlyMap<string, Role>
    {
        return new Map(JSON.parse(String(value)) as Array<[string, Role]>)
    }
}
