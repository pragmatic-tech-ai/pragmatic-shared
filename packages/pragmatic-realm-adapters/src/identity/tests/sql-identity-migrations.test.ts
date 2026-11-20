import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlTestSessions } from '../../testing/sql-test-sessions.js'
import { SqlLocalAccountStore } from '../sql-local-account-store.js'
import { SqlSessionStore } from '../sql-session-store.js'
import { SqlServiceTokenStore } from '../sql-service-token-store.js'
import { SqlRoleGrantStore } from '../sql-role-grant-store.js'
import { SqlIdpDirectoryStore } from '../sql-idp-directory-store.js'
import { SqlRealmConfigStore } from '../sql-realm-config-store.js'
import { SqlAuditStore } from '../sql-audit-store.js'
import { SqlAuditCheckpointStore } from '../sql-audit-checkpoint-store.js'

/** The tables exactly as the pre-migration Open() bootstraps created them (the 0.1.x stores), with one row each. */
class PreMigrationSchema
{
    public static readonly Statements: readonly string[] = [
        'CREATE TABLE identity_accounts (realm_id text, principal_id text, email text, secret_ref text, groups text, disabled boolean NOT NULL DEFAULT false, PRIMARY KEY (realm_id, principal_id), UNIQUE (realm_id, email))',
        'CREATE TABLE identity_groups (realm_id text NOT NULL, group_id text NOT NULL, name text NOT NULL, member_ids text NOT NULL, PRIMARY KEY (realm_id, group_id))',
        'CREATE TABLE identity_sessions (hash text PRIMARY KEY, principal_id text NOT NULL, realm_id text NOT NULL, issued_at text NOT NULL, expires_at text NOT NULL)',
        'CREATE TABLE identity_service_tokens (hash text PRIMARY KEY, token_ref text NOT NULL, principal_id text NOT NULL, realm_id text NOT NULL, scopes text NOT NULL, expires_at text, revoked boolean NOT NULL)',
        'CREATE TABLE identity_role_grants (subject text NOT NULL, role integer NOT NULL, resource_kind integer NOT NULL, resource_realm_id text NOT NULL, resource_path text NOT NULL)',
        'CREATE TABLE identity_idp_directory (realm_id text PRIMARY KEY, taken_at text NOT NULL, authoritative boolean NOT NULL, users text NOT NULL, groups text NOT NULL)',
        'CREATE TABLE identity_realm_config (realm_id text PRIMARY KEY, pack_id text NOT NULL, delegation_depth integer NOT NULL, provider_settings text NOT NULL, group_role_map text NOT NULL, claims_mapping text NOT NULL)',
        'CREATE TABLE identity_audit (realm_id text, seq integer, kind integer, principal_id text, at text, detail text)',
        'CREATE UNIQUE INDEX identity_audit_pk ON identity_audit (realm_id, seq)',
        'ALTER TABLE identity_audit ADD COLUMN hash text',
        'ALTER TABLE identity_audit ADD COLUMN prev_hash text',
        'CREATE TABLE identity_audit_anchor (realm_id text, seq integer, head_hash text, at text, signature text)',
        'CREATE UNIQUE INDEX identity_audit_anchor_pk ON identity_audit_anchor (realm_id, seq)',
    ]

    public static async Create(session: ISqlSession, realmId: string): Promise<void>
    {
        for (const statement of PreMigrationSchema.Statements)
        {
            await session.Execute(statement, [])
        }
        await session.Execute('INSERT INTO identity_accounts (realm_id, principal_id, email, secret_ref, groups, disabled) VALUES ($1, $2, $3, $4, $5, $6)', [realmId, 'old-p', 'old@x.io', 'old-ref', '[]', false])
        await session.Execute('INSERT INTO identity_role_grants (subject, role, resource_kind, resource_realm_id, resource_path) VALUES ($1, $2, $3, $4, $5)', ['old-p', 1, 0, realmId, '[]'])
    }
}

class StoreSet
{
    public static async OpenAll(session: ISqlSession): Promise<SqlLocalAccountStore>
    {
        const accounts = await SqlLocalAccountStore.Open(session)
        await SqlSessionStore.Open(session)
        await SqlServiceTokenStore.Open(session)
        await SqlRoleGrantStore.Open(session)
        await SqlIdpDirectoryStore.Open(session)
        await SqlRealmConfigStore.Open(session)
        await SqlAuditStore.Open(session)
        await SqlAuditCheckpointStore.Open(session)
        return accounts
    }

    public static async Versions(session: ISqlSession): Promise<ReadonlyMap<string, number>>
    {
        const rows = await session.Query('SELECT module, MAX(version) AS version FROM schema_migrations GROUP BY module', [])
        return new Map(rows.map(r => [String(r.module), Number(r.version)]))
    }
}

SqlTestSessions.Describe('SQL identity store migrations', (makeSession, backend) =>
{
    test(`${backend}: every store records its module in schema_migrations on Open`, async () =>
    {
        const session = await makeSession()
        await StoreSet.OpenAll(session)
        assert.deepEqual([...(await StoreSet.Versions(session))].sort(), [
            ['identity.accounts', 2],
            ['identity.audit', 1],
            ['identity.audit_checkpoints', 1],
            ['identity.idp_directory', 1],
            ['identity.realm_config', 1],
            ['identity.role_grants', 1],
            ['identity.service_tokens', 1],
            ['identity.sessions', 1],
        ])
    })

    test(`${backend}: reopening applies nothing new`, async () =>
    {
        const session = await makeSession()
        await StoreSet.OpenAll(session)
        const before = await session.Query('SELECT module, version, applied_at FROM schema_migrations ORDER BY module, version', [])
        await StoreSet.OpenAll(session)
        const after = await session.Query('SELECT module, version, applied_at FROM schema_migrations ORDER BY module, version', [])
        assert.deepEqual(after, before)
    })

    test(`${backend}: Open over tables the pre-migration code created keeps their rows`, async () =>
    {
        const session = await makeSession()
        const realm = new Realm(`mig-${randomUUID()}`, RealmKind.SelfHosted, 'T')
        await PreMigrationSchema.Create(session, realm.Id)
        const accounts = await StoreSet.OpenAll(session)
        assert.equal((await accounts.FindByEmail(realm, 'old@x.io'))?.PrincipalId, 'old-p')
        assert.equal((await (await SqlRoleGrantStore.Open(session)).GrantsFor('old-p', realm)).length, 1)
        await accounts.CreateAccount(realm, 'new@x.io', 'new-p', 'new-ref')
        assert.equal((await accounts.ListAccounts(realm)).length, 2)
    })

    test(`${backend}: identity.accounts v2 drops the retired legacy groups column`, async () =>
    {
        const session = await makeSession()
        await SqlLocalAccountStore.Open(session)
        await assert.rejects(() => session.Query('SELECT groups FROM identity_accounts', []))
    })
})
