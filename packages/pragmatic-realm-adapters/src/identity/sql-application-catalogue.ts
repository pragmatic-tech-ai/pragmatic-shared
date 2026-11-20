import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { ApplicationDeclaration, ApplicationRoleDeclaration } from '@pragmatic-tech-ai/pragmatic-identity'
import type { IApplicationCatalogue } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlApplicationCatalogueMigrations } from './sql-identity-migrations.js'

/** Postgres-backed application catalogue: one row per (realm, application), its roles a JSON array of
 *  [name, description]; Declare upserts. Unreadable role entries are dropped on read (an undeclared role grants nothing). */
export class SqlApplicationCatalogue implements IApplicationCatalogue
{
    private static readonly Table = 'identity_applications'

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlApplicationCatalogue>
    {
        await SqlMigrationRunner.Run(session, new SqlApplicationCatalogueMigrations())
        return new SqlApplicationCatalogue(session)
    }

    public async Applications(realmId: string): Promise<readonly ApplicationDeclaration[]>
    {
        const rows = await this.session.Query(`SELECT application, roles FROM ${SqlApplicationCatalogue.Table} WHERE realm_id = $1`, [realmId])
        return rows.map(SqlApplicationCatalogue.ToDeclaration).sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0))
    }

    public async Application(realmId: string, name: string): Promise<ApplicationDeclaration | null>
    {
        const rows = await this.session.Query(`SELECT application, roles FROM ${SqlApplicationCatalogue.Table} WHERE realm_id = $1 AND application = $2`, [realmId, name])
        const row = rows[0]
        return row === undefined ? null : SqlApplicationCatalogue.ToDeclaration(row)
    }

    public async Declare(realmId: string, application: ApplicationDeclaration): Promise<void>
    {
        const roles = JSON.stringify(application.Roles.map(role => [role.Name, role.Description]))
        await this.session.Execute(`INSERT INTO ${SqlApplicationCatalogue.Table} (realm_id, application, roles) VALUES ($1, $2, $3) ON CONFLICT (realm_id, application) DO UPDATE SET roles = $3`, [realmId, application.Name, roles])
    }

    public async Remove(realmId: string, name: string): Promise<boolean>
    {
        return (await this.session.Execute(`DELETE FROM ${SqlApplicationCatalogue.Table} WHERE realm_id = $1 AND application = $2`, [realmId, name])) > 0
    }

    private static ToDeclaration(row: SqlRow): ApplicationDeclaration
    {
        return new ApplicationDeclaration(String(row.application), SqlApplicationCatalogue.ToRoles(row.roles))
    }

    private static ToRoles(value: unknown): ApplicationRoleDeclaration[]
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(String(value))
        }
        catch
        {
            return []
        }
        if (!Array.isArray(parsed))
        {
            return []
        }
        const roles: ApplicationRoleDeclaration[] = []
        for (const entry of parsed)
        {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
            {
                roles.push(new ApplicationRoleDeclaration(entry[0], entry[1]))
            }
        }
        return roles
    }
}
