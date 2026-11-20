import { SqlMigration, SqlMigrationModule } from '../sql/sql-migration.js'

/* The schema history of the SQL identity stores, one module per store. Each step's SQL is frozen literal text (its
 * checksum is recorded when it runs), never built from a store's constants. Version 1 of every module is the schema
 * the pre-migration (0.1.x) Open() bootstraps created, with their ad-hoc additions folded in; it keeps
 * IF NOT EXISTS so it applies cleanly over tables that code already created. Later versions are plain DDL. */

export class SqlLocalAccountMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_accounts (realm_id text, principal_id text, email text, secret_ref text, groups text, disabled boolean NOT NULL DEFAULT false, PRIMARY KEY (realm_id, principal_id), UNIQUE (realm_id, email))',
        'ALTER TABLE identity_accounts ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false',
        'CREATE TABLE IF NOT EXISTS identity_groups (realm_id text NOT NULL, group_id text NOT NULL, name text NOT NULL, member_ids text NOT NULL, PRIMARY KEY (realm_id, group_id))',
    ])
    /** The pre-S3 per-account groups column: the old Open() folded it into identity_groups on every start, so no row
     *  written by that code still carries groups; it is retired. */
    private static readonly V2 = new SqlMigration(2, [
        'ALTER TABLE identity_accounts DROP COLUMN groups',
    ])

    public readonly Name = 'identity.accounts'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlLocalAccountMigrations.V1, SqlLocalAccountMigrations.V2]
    }
}

export class SqlSessionMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_sessions (hash text PRIMARY KEY, principal_id text NOT NULL, realm_id text NOT NULL, issued_at text NOT NULL, expires_at text NOT NULL)',
    ])

    public readonly Name = 'identity.sessions'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlSessionMigrations.V1]
    }
}

export class SqlServiceTokenMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_service_tokens (hash text PRIMARY KEY, token_ref text NOT NULL, principal_id text NOT NULL, realm_id text NOT NULL, scopes text NOT NULL, expires_at text, revoked boolean NOT NULL)',
    ])

    public readonly Name = 'identity.service_tokens'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlServiceTokenMigrations.V1]
    }
}

export class SqlRoleGrantMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_role_grants (subject text NOT NULL, role integer NOT NULL, resource_kind integer NOT NULL, resource_realm_id text NOT NULL, resource_path text NOT NULL)',
    ])

    public readonly Name = 'identity.role_grants'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlRoleGrantMigrations.V1]
    }
}

export class SqlIdpDirectoryMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_idp_directory (realm_id text PRIMARY KEY, taken_at text NOT NULL, authoritative boolean NOT NULL, users text NOT NULL, groups text NOT NULL)',
    ])

    public readonly Name = 'identity.idp_directory'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlIdpDirectoryMigrations.V1]
    }
}

export class SqlRealmConfigMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_realm_config (realm_id text PRIMARY KEY, pack_id text NOT NULL, delegation_depth integer NOT NULL, provider_settings text NOT NULL, group_role_map text NOT NULL, claims_mapping text NOT NULL)',
    ])

    public readonly Name = 'identity.realm_config'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlRealmConfigMigrations.V1]
    }
}

/** v1 folds in the old duplicate-column-catch ALTERs as ADD COLUMN IF NOT EXISTS. */
export class SqlAuditMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_audit (realm_id text, seq integer, kind integer, principal_id text, at text, detail text)',
        'CREATE UNIQUE INDEX IF NOT EXISTS identity_audit_pk ON identity_audit (realm_id, seq)',
        'ALTER TABLE identity_audit ADD COLUMN IF NOT EXISTS hash text',
        'ALTER TABLE identity_audit ADD COLUMN IF NOT EXISTS prev_hash text',
    ])

    public readonly Name = 'identity.audit'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlAuditMigrations.V1]
    }
}

export class SqlAuditCheckpointMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE IF NOT EXISTS identity_audit_anchor (realm_id text, seq integer, head_hash text, at text, signature text)',
        'CREATE UNIQUE INDEX IF NOT EXISTS identity_audit_anchor_pk ON identity_audit_anchor (realm_id, seq)',
    ])

    public readonly Name = 'identity.audit_checkpoints'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlAuditCheckpointMigrations.V1]
    }
}

/** The realm's role mappings: one row per (role, member); the role is its qualified text (`admin`, `ledger:finance`). */
export class SqlRoleMappingMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE identity_role_mappings (realm_id text NOT NULL, role text NOT NULL, member_kind text NOT NULL, member_source text NOT NULL, member_value text NOT NULL, PRIMARY KEY (realm_id, role, member_kind, member_source, member_value))',
    ])

    public readonly Name = 'identity.role_mappings'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlRoleMappingMigrations.V1]
    }
}

/** The realm's application catalogue: one row per application, its declared roles as a JSON array of [name, description]. */
export class SqlApplicationCatalogueMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE identity_applications (realm_id text NOT NULL, application text NOT NULL, roles text NOT NULL, PRIMARY KEY (realm_id, application))',
    ])

    public readonly Name = 'identity.applications'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlApplicationCatalogueMigrations.V1]
    }
}
