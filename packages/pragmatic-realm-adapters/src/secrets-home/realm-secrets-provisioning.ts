import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule } from '../sql/sql-migration.js'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlSecretMigrations } from '../secrets/sql-secret-store.js'

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

/** One realm's roles in the custom secrets home: the tenant admin console's role writes, every other component's role
 *  only reads. */
export class RealmSecretsGrant
{
    private static readonly RolePattern = /^[a-z_][a-z0-9_]{0,62}$/
    private static readonly RealmPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
    private static readonly BadRole = 'a realm secrets role is lowercase letters, digits and "_" (at most 63)'
    private static readonly BadRealm = 'a realm id is lowercase letters, digits and "-" (at most 63)'
    private static readonly WriterReads = 'the writer role cannot also be a reader role'

    public readonly Readers: readonly string[]

    public constructor(public readonly RealmId: string, public readonly Writer: string, readers: readonly string[])
    {
        const G = RealmSecretsGrant
        if (!G.RealmPattern.test(RealmId)) throw new Error(G.BadRealm)
        for (const role of [Writer, ...readers])
        {
            if (!G.RolePattern.test(role)) throw new Error(G.BadRole)
        }
        if (readers.includes(Writer)) throw new Error(G.WriterReads)
        this.Readers = Object.freeze([...new Set(readers)].sort())
        Object.freeze(this)
    }
}

/**
 * Sets up the custom option's `realm_secrets` database, as the database's owner (the engine chart's bootstrap Job, with
 * the Postgres superuser): the sealed-secrets table, the grants table, `CONNECT` and schema usage for the realm's roles, row-level security on the sealed secrets (forced,
 * so even the table's owner is bound by it) and the roles' privileges. A role sees, and the writer changes, only the
 * rows of the realms the grants table gives it (`scope = 'realm/<realm>'`); a reader role has `SELECT` only. The login
 * roles themselves (and their passwords) are the bootstrap's; this only grants. Idempotent: run on every install and
 * upgrade, it converges the grants of each realm it is given and never touches a sealed row.
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
    ]
    private static readonly ClearRealmSql = 'DELETE FROM realm_secret_grants WHERE realm_id = $1'
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
            const writers = new Map<string, boolean>()
            for (const grant of grants)
            {
                await tx.Execute(P.ClearRealmSql, [grant.RealmId])
                await tx.Execute(P.GrantRowSql, [grant.Writer, grant.RealmId, true])
                writers.set(grant.Writer, true)
                for (const reader of grant.Readers)
                {
                    await tx.Execute(P.GrantRowSql, [reader, grant.RealmId, false])
                    writers.set(reader, writers.get(reader) === true)
                }
            }
            // One privilege set per role over every realm it was given here: a writer anywhere keeps writing.
            for (const [role, writer] of writers)
            {
                await P.Privileges(tx, database, schema, role, writer ? P.WriterPrivileges : P.ReaderPrivileges)
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

    // Role names are pattern-checked by RealmSecretsGrant; the schema and database are the session's own. Quoted either way.
    private static Identifier(name: string): string
    {
        return RealmSecretsProvisioning.Quote + name.split(RealmSecretsProvisioning.Quote).join(RealmSecretsProvisioning.Quote + RealmSecretsProvisioning.Quote) + RealmSecretsProvisioning.Quote
    }
}
