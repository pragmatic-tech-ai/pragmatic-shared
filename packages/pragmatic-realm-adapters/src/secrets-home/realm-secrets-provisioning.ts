import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule } from '../sql/sql-migration.js'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlSecretMigrations } from '../secrets/sql-secret-store.js'
import { WorkloadContext } from './workload-context.js'

/** Schema of the custom secrets home beside the sealed secrets: which database role may read or write which realm. */
export class RealmSecretsMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE realm_secret_grants (role_name text NOT NULL, realm_id text NOT NULL, writer boolean NOT NULL, PRIMARY KEY (role_name, realm_id))',
    ])

    public readonly Name = 'realm.secrets'

    public Migrations(): readonly SqlMigration[]
    {
        return [RealmSecretsMigrations.V1]
    }
}

/** One realm's roles in the custom secrets home: the writers (the tenant admin console, where tenant admins enter
 *  secrets, and the realm sign-in service, whose admin API and import write realm secrets) and the readers (every other
 *  component). */
export class RealmSecretsGrant
{
    private static readonly RolePattern = /^[a-z_][a-z0-9_]{0,62}$/
    private static readonly BadRole = 'a realm secrets role is lowercase letters, digits and "_" (at most 63)'
    private static readonly NoWriter = 'a realm needs at least one writer role'
    private static readonly WriterReads = 'a writer role cannot also be a reader role'

    public readonly Writers: readonly string[]
    public readonly Readers: readonly string[]

    public constructor(public readonly RealmId: string, writers: readonly string[], readers: readonly string[])
    {
        const G = RealmSecretsGrant
        if (!WorkloadContext.RealmPattern.test(RealmId)) throw new Error(WorkloadContext.BadRealm)
        if (writers.length === 0) throw new Error(G.NoWriter)
        for (const role of [...writers, ...readers])
        {
            if (!G.RolePattern.test(role)) throw new Error(G.BadRole)
        }
        if (readers.some(reader => writers.includes(reader))) throw new Error(G.WriterReads)
        this.Writers = Object.freeze([...new Set(writers)].sort())
        this.Readers = Object.freeze([...new Set(readers)].sort())
        Object.freeze(this)
    }
}

/**
 * Sets up the custom option's `realm_secrets` database, as the database's owner (the engine chart's bootstrap Job, with
 * the Postgres superuser): the sealed-secrets table, the grants table, `CONNECT` and schema usage for the realm's roles,
 * row-level security (forced, so even the tables' owner is bound by it) and the roles' privileges. A role sees, and a
 * writer changes, only the rows of the realms the grants table gives it (`scope = 'realm/<realm>'`), and sees only its
 * own grant rows; a reader role has `SELECT` only. Each role's privileges follow all its grant rows (earlier runs'
 * included), and a role whose last grant a run removes loses them. The login roles themselves (and their passwords) are
 * the bootstrap's; this only grants. Idempotent: run on every install and upgrade, it converges the grants of each realm
 * it is given and never touches a sealed row.
 */
export class RealmSecretsProvisioning
{
    private static readonly SchemaSql = 'SELECT current_schema() AS schema, current_database() AS database'
    private static readonly SecureStatements: readonly string[] = [
        'ALTER TABLE sealed_secrets ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE sealed_secrets FORCE ROW LEVEL SECURITY',
        'DROP POLICY IF EXISTS realm_secrets_read ON sealed_secrets',
        'DROP POLICY IF EXISTS realm_secrets_write ON sealed_secrets',
        "CREATE POLICY realm_secrets_read ON sealed_secrets FOR SELECT USING (EXISTS (SELECT 1 FROM realm_secret_grants g WHERE g.role_name = current_user AND sealed_secrets.scope = 'realm/' || g.realm_id))",
        "CREATE POLICY realm_secrets_write ON sealed_secrets FOR ALL USING (EXISTS (SELECT 1 FROM realm_secret_grants g WHERE g.role_name = current_user AND g.writer AND sealed_secrets.scope = 'realm/' || g.realm_id)) WITH CHECK (EXISTS (SELECT 1 FROM realm_secret_grants g WHERE g.role_name = current_user AND g.writer AND sealed_secrets.scope = 'realm/' || g.realm_id))",
        // A role sees its own grant rows only: no role learns another realm's id or roles.
        'ALTER TABLE realm_secret_grants ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE realm_secret_grants FORCE ROW LEVEL SECURITY',
        'DROP POLICY IF EXISTS realm_secret_grants_own ON realm_secret_grants',
        'CREATE POLICY realm_secret_grants_own ON realm_secret_grants FOR SELECT USING (role_name = current_user)',
    ]
    private static readonly ClearRealmSql = 'DELETE FROM realm_secret_grants WHERE realm_id = $1 RETURNING role_name'
    private static readonly RolesSql = 'SELECT role_name, bool_or(writer) AS writer FROM realm_secret_grants GROUP BY role_name'
    private static readonly GrantRowSql = 'INSERT INTO realm_secret_grants (role_name, realm_id, writer) VALUES ($1, $2, $3)'
    private static readonly Quote = '"'
    private static readonly WriterPrivileges = 'SELECT, INSERT, UPDATE, DELETE'
    private static readonly ReaderPrivileges = 'SELECT'

    public static async Run(session: ISqlSession, grants: readonly RealmSecretsGrant[]): Promise<void>
    {
        const P = RealmSecretsProvisioning
        await SqlMigrationRunner.Run(session, new SqlSecretMigrations())
        await SqlMigrationRunner.Run(session, new RealmSecretsMigrations())
        const where = (await session.Query(P.SchemaSql, []))[0]!
        const schema = String(where.schema)
        const database = String(where.database)
        // The migration runner has refused a session without transactions already.
        await session.Transaction!(async tx =>
        {
            for (const statement of P.SecureStatements)
            {
                await tx.Execute(statement, [])
            }
            const cleared = new Set<string>()
            for (const grant of grants)
            {
                for (const row of await tx.Query(P.ClearRealmSql, [grant.RealmId])) cleared.add(String(row.role_name))
                for (const writer of grant.Writers)
                {
                    await tx.Execute(P.GrantRowSql, [writer, grant.RealmId, true])
                }
                for (const reader of grant.Readers)
                {
                    await tx.Execute(P.GrantRowSql, [reader, grant.RealmId, false])
                }
            }
            // Privileges from every grant row, of this run and earlier ones: a writer in any realm keeps writing.
            const remaining = new Set<string>()
            for (const row of await tx.Query(P.RolesSql, []))
            {
                const role = String(row.role_name)
                remaining.add(role)
                await P.Privileges(tx, database, schema, role, row.writer === true ? P.WriterPrivileges : P.ReaderPrivileges)
            }
            // A role this run took its last grant from keeps nothing.
            for (const role of cleared)
            {
                if (!remaining.has(role)) await P.Revoke(tx, role)
            }
        })
    }

    private static async Privileges(tx: ISqlSession, database: string, schema: string, role: string, onSecrets: string): Promise<void>
    {
        const P = RealmSecretsProvisioning
        const name = P.Identifier(role)
        await tx.Execute(`GRANT CONNECT ON DATABASE ${P.Identifier(database)} TO ${name}`, [])
        await tx.Execute(`GRANT USAGE ON SCHEMA ${P.Identifier(schema)} TO ${name}`, [])
        await tx.Execute(`REVOKE ALL ON sealed_secrets FROM ${name}`, [])
        await tx.Execute(`GRANT ${onSecrets} ON sealed_secrets TO ${name}`, [])
        await tx.Execute(`GRANT SELECT ON realm_secret_grants TO ${name}`, [])
    }

    private static async Revoke(tx: ISqlSession, role: string): Promise<void>
    {
        const P = RealmSecretsProvisioning
        const name = P.Identifier(role)
        await tx.Execute(`REVOKE ALL ON sealed_secrets FROM ${name}`, [])
        await tx.Execute(`REVOKE ALL ON realm_secret_grants FROM ${name}`, [])
    }

    // Role names are pattern-checked by RealmSecretsGrant; the schema and database are the session's own. Quoted either way.
    private static Identifier(name: string): string
    {
        return RealmSecretsProvisioning.Quote + name.split(RealmSecretsProvisioning.Quote).join(RealmSecretsProvisioning.Quote + RealmSecretsProvisioning.Quote) + RealmSecretsProvisioning.Quote
    }
}
