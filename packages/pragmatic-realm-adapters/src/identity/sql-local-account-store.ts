import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { Principal, PrincipalKind, LocalAccount, LocalAccountNotFoundError, LocalGroup, LocalGroupNotFoundError, SystemPrincipal } from '@pragmatic-tech-ai/pragmatic-identity'
import type { Realm, ILocalAccountStore, ILocalGroupStore, IPrincipalDirectory } from '@pragmatic-tech-ai/pragmatic-identity'

/** Postgres-backed local account store (+ principal directory + local groups). One account row per
 *  (realm_id, principal_id); email is unique within a realm. Mirrors FileAccountStore: duplicate email OR
 *  principal within a realm is rejected (pre-checked), reserved system principal ids are refused, secrets stay
 *  by reference (secret_ref). Local groups live in their own table keyed by (realm_id, group_id) (the
 *  composite key keeps groups of different realms collision-free) with the member ids as a JSON array in
 *  insertion order. Group mutators only read for the existence check; CreateGroup is the only path that adds a
 *  group. A legacy (pre-S3) account row's `groups` JSON is migrated once on Open into group rows (name = group
 *  id) and then cleared. */
export class SqlLocalAccountStore implements ILocalAccountStore, IPrincipalDirectory, ILocalGroupStore
{
    private static readonly Table = 'identity_accounts'
    private static readonly GroupTable = 'identity_groups'
    private static readonly EmptyGroups = '[]'
    private static readonly DuplicateEmailMessage = 'email already registered'
    private static readonly DuplicatePrincipalMessage = 'principal already registered'
    private static readonly ReservedPrincipalMessage = 'principal id uses the reserved system prefix'
    private static readonly DuplicateGroupMessage = 'group already exists'

    private readonly session: ISqlSession

    private constructor(session: ISqlSession)
    {
        this.session = session
    }

    public static async Open(session: ISqlSession): Promise<SqlLocalAccountStore>
    {
        await session.Execute(`CREATE TABLE IF NOT EXISTS ${SqlLocalAccountStore.Table} (realm_id text, principal_id text, email text, secret_ref text, groups text, disabled boolean NOT NULL DEFAULT false, PRIMARY KEY (realm_id, principal_id), UNIQUE (realm_id, email))`, [])
        await session.Execute(`ALTER TABLE ${SqlLocalAccountStore.Table} ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false`, [])
        await session.Execute(`CREATE TABLE IF NOT EXISTS ${SqlLocalAccountStore.GroupTable} (realm_id text NOT NULL, group_id text NOT NULL, name text NOT NULL, member_ids text NOT NULL, PRIMARY KEY (realm_id, group_id))`, [])
        const store = new SqlLocalAccountStore(session)
        await store.MigrateLegacyGroups()
        return store
    }

    public async CreateAccount(realm: Realm, email: string, principalId: string, secretRef: string): Promise<LocalAccount>
    {
        if (SystemPrincipal.IsReserved(principalId))
        {
            throw new Error(SqlLocalAccountStore.ReservedPrincipalMessage)
        }
        if (await this.FindByEmail(realm, email) !== null)
        {
            throw new Error(SqlLocalAccountStore.DuplicateEmailMessage)
        }
        if (await this.FindByPrincipalId(realm, principalId) !== null)
        {
            throw new Error(SqlLocalAccountStore.DuplicatePrincipalMessage)
        }
        await this.session.Execute(`INSERT INTO ${SqlLocalAccountStore.Table} (realm_id, principal_id, email, secret_ref, groups, disabled) VALUES ($1, $2, $3, $4, $5, $6)`, [realm.Id, principalId, email, secretRef, SqlLocalAccountStore.EmptyGroups, false])
        return new LocalAccount(principalId, realm.Id, email, secretRef, false)
    }

    public async FindByEmail(realm: Realm, email: string): Promise<LocalAccount | null>
    {
        const rows = await this.session.Query(`SELECT realm_id, principal_id, email, secret_ref, disabled FROM ${SqlLocalAccountStore.Table} WHERE realm_id = $1 AND email = $2`, [realm.Id, email])
        return SqlLocalAccountStore.ToAccount(rows[0])
    }

    public async FindByPrincipalId(realm: Realm, principalId: string): Promise<LocalAccount | null>
    {
        const rows = await this.session.Query(`SELECT realm_id, principal_id, email, secret_ref, disabled FROM ${SqlLocalAccountStore.Table} WHERE realm_id = $1 AND principal_id = $2`, [realm.Id, principalId])
        return SqlLocalAccountStore.ToAccount(rows[0])
    }

    public async Disable(realm: Realm, principalId: string): Promise<void>
    {
        const changed = await this.session.Execute(`UPDATE ${SqlLocalAccountStore.Table} SET disabled = true WHERE realm_id = $1 AND principal_id = $2`, [realm.Id, principalId])
        if (changed === 0)
        {
            throw new LocalAccountNotFoundError(principalId)
        }
    }

    public async Enable(realm: Realm, principalId: string): Promise<void>
    {
        const changed = await this.session.Execute(`UPDATE ${SqlLocalAccountStore.Table} SET disabled = false WHERE realm_id = $1 AND principal_id = $2`, [realm.Id, principalId])
        if (changed === 0)
        {
            throw new LocalAccountNotFoundError(principalId)
        }
    }

    public async ListAccounts(realm: Realm): Promise<readonly LocalAccount[]>
    {
        const rows = await this.session.Query(`SELECT realm_id, principal_id, email, secret_ref, disabled FROM ${SqlLocalAccountStore.Table} WHERE realm_id = $1`, [realm.Id])
        return rows.map(row => SqlLocalAccountStore.MapRow(row))
    }

    public async Lookup(principalId: string, realm: Realm): Promise<Principal | null>
    {
        const rows = await this.session.Query(`SELECT principal_id FROM ${SqlLocalAccountStore.Table} WHERE realm_id = $1 AND principal_id = $2 AND disabled = false`, [realm.Id, principalId])
        if (rows[0] === undefined)
        {
            return null
        }
        return new Principal(principalId, realm.Id, PrincipalKind.User, new Map(), await this.GroupIdsOf(realm.Id, principalId))
    }

    public async GroupsOf(principal: Principal): Promise<readonly string[]>
    {
        if (principal.Groups.length > 0)
        {
            return principal.Groups
        }
        return this.GroupIdsOf(principal.RealmId, principal.Id)
    }

    public async CreateGroup(realm: Realm, groupId: string, name: string): Promise<LocalGroup>
    {
        if (await this.FindGroup(realm.Id, groupId) !== null)
        {
            throw new Error(SqlLocalAccountStore.DuplicateGroupMessage)
        }
        await this.InsertGroup(realm.Id, groupId, name)
        return new LocalGroup(groupId, realm.Id, name, [])
    }

    public async DeleteGroup(realm: Realm, groupId: string): Promise<void>
    {
        await this.RequireGroup(realm, groupId)
        await this.session.Execute(`DELETE FROM ${SqlLocalAccountStore.GroupTable} WHERE realm_id = $1 AND group_id = $2`, [realm.Id, groupId])
    }

    public async AddMember(realm: Realm, groupId: string, principalId: string): Promise<void>
    {
        const group = await this.RequireGroup(realm, groupId)
        if (group.MemberIds.includes(principalId))
        {
            return
        }
        await this.WriteMembers(realm.Id, groupId, [...group.MemberIds, principalId])
    }

    public async RemoveMember(realm: Realm, groupId: string, principalId: string): Promise<void>
    {
        const group = await this.RequireGroup(realm, groupId)
        await this.WriteMembers(realm.Id, groupId, group.MemberIds.filter(id => id !== principalId))
    }

    public async ListGroups(realm: Realm): Promise<readonly LocalGroup[]>
    {
        const rows = await this.session.Query(`SELECT realm_id, group_id, name, member_ids FROM ${SqlLocalAccountStore.GroupTable} WHERE realm_id = $1 ORDER BY group_id`, [realm.Id])
        return rows.map(row => SqlLocalAccountStore.MapGroup(row))
    }

    /** One-shot, idempotent: folds every non-empty legacy account `groups` array into group rows, then clears it. */
    private async MigrateLegacyGroups(): Promise<void>
    {
        const rows = await this.session.Query(`SELECT realm_id, principal_id, groups FROM ${SqlLocalAccountStore.Table} WHERE groups IS NOT NULL AND groups <> $1`, [SqlLocalAccountStore.EmptyGroups])
        for (const row of rows)
        {
            const realmId = String(row.realm_id)
            const principalId = String(row.principal_id)
            for (const groupId of JSON.parse(String(row.groups)) as readonly string[])
            {
                await this.JoinLegacyGroup(realmId, groupId, principalId)
            }
            await this.session.Execute(`UPDATE ${SqlLocalAccountStore.Table} SET groups = $1 WHERE realm_id = $2 AND principal_id = $3`, [SqlLocalAccountStore.EmptyGroups, realmId, principalId])
        }
    }

    private async JoinLegacyGroup(realmId: string, groupId: string, principalId: string): Promise<void>
    {
        let group = await this.FindGroup(realmId, groupId)
        if (group === null)
        {
            await this.InsertGroup(realmId, groupId, groupId)
            group = new LocalGroup(groupId, realmId, groupId, [])
        }
        if (!group.MemberIds.includes(principalId))
        {
            await this.WriteMembers(realmId, groupId, [...group.MemberIds, principalId])
        }
    }

    private async RequireGroup(realm: Realm, groupId: string): Promise<LocalGroup>
    {
        const group = await this.FindGroup(realm.Id, groupId)
        if (group === null)
        {
            throw new LocalGroupNotFoundError(groupId)
        }
        return group
    }

    private async FindGroup(realmId: string, groupId: string): Promise<LocalGroup | null>
    {
        const rows = await this.session.Query(`SELECT realm_id, group_id, name, member_ids FROM ${SqlLocalAccountStore.GroupTable} WHERE realm_id = $1 AND group_id = $2`, [realmId, groupId])
        return rows[0] === undefined ? null : SqlLocalAccountStore.MapGroup(rows[0])
    }

    private async InsertGroup(realmId: string, groupId: string, name: string): Promise<void>
    {
        await this.session.Execute(`INSERT INTO ${SqlLocalAccountStore.GroupTable} (realm_id, group_id, name, member_ids) VALUES ($1, $2, $3, $4)`, [realmId, groupId, name, SqlLocalAccountStore.EmptyGroups])
    }

    private async WriteMembers(realmId: string, groupId: string, memberIds: readonly string[]): Promise<void>
    {
        await this.session.Execute(`UPDATE ${SqlLocalAccountStore.GroupTable} SET member_ids = $1 WHERE realm_id = $2 AND group_id = $3`, [JSON.stringify(memberIds), realmId, groupId])
    }

    private async GroupIdsOf(realmId: string, principalId: string): Promise<readonly string[]>
    {
        const rows = await this.session.Query(`SELECT realm_id, group_id, name, member_ids FROM ${SqlLocalAccountStore.GroupTable} WHERE realm_id = $1 ORDER BY group_id`, [realmId])
        return rows
            .map(row => SqlLocalAccountStore.MapGroup(row))
            .filter(group => group.MemberIds.includes(principalId))
            .map(group => group.GroupId)
    }

    private static MapGroup(row: SqlRow): LocalGroup
    {
        return new LocalGroup(String(row.group_id), String(row.realm_id), String(row.name), JSON.parse(String(row.member_ids)) as readonly string[])
    }

    private static ToAccount(row: SqlRow | undefined): LocalAccount | null
    {
        if (row === undefined)
        {
            return null
        }
        return SqlLocalAccountStore.MapRow(row)
    }

    private static MapRow(row: SqlRow): LocalAccount
    {
        return new LocalAccount(String(row.principal_id), String(row.realm_id), String(row.email), String(row.secret_ref), row.disabled === true)
    }
}
