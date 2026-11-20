import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { OidcFlowState } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { SqlMigration, SqlMigrationModule } from '../sql/sql-migration.js'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'

/** Schema of the pending OIDC sign-in flows. */
export class SqlOidcFlowStateMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE oidc_flow_states (state text PRIMARY KEY, nonce text NOT NULL, code_verifier text NOT NULL, redirect_uri text NOT NULL, expires_at timestamptz NOT NULL)',
        'CREATE INDEX oidc_flow_states_expires ON oidc_flow_states (expires_at)',
    ])
    /** The application's return path (OidcFlowState.ReturnPath); nullable, so a row put by an older writer reads as
     *  no return path. */
    private static readonly V2 = new SqlMigration(2, [
        'ALTER TABLE oidc_flow_states ADD COLUMN return_path text',
    ])

    public readonly Name = 'oidc.flow_states'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlOidcFlowStateMigrations.V1, SqlOidcFlowStateMigrations.V2]
    }
}

/** Postgres IOidcFlowStateStore: pending sign-ins survive a restart and are shared by every replica. Take is one
 *  `DELETE ... RETURNING`, so a state is consumed atomically and exactly one caller gets it; an expired state is
 *  consumed and reads as null. Put upserts (as the in-memory store does) and sweeps states that expired unused. */
export class SqlOidcFlowStateStore implements IOidcFlowStateStore
{
    private static readonly PutSql = 'INSERT INTO oidc_flow_states (state, nonce, code_verifier, redirect_uri, expires_at, return_path) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (state) DO UPDATE SET nonce = EXCLUDED.nonce, code_verifier = EXCLUDED.code_verifier, redirect_uri = EXCLUDED.redirect_uri, expires_at = EXCLUDED.expires_at, return_path = EXCLUDED.return_path'
    private static readonly SweepSql = 'DELETE FROM oidc_flow_states WHERE expires_at <= $1'
    private static readonly TakeSql = 'DELETE FROM oidc_flow_states WHERE state = $1 RETURNING state, nonce, code_verifier, redirect_uri, expires_at, return_path'

    private constructor(private readonly session: ISqlSession, private readonly now: () => Date)
    {
    }

    public static async Open(session: ISqlSession, now: () => Date = () => new Date()): Promise<SqlOidcFlowStateStore>
    {
        await SqlMigrationRunner.Run(session, new SqlOidcFlowStateMigrations())
        return new SqlOidcFlowStateStore(session, now)
    }

    public async Put(state: OidcFlowState): Promise<void>
    {
        await this.session.Execute(SqlOidcFlowStateStore.SweepSql, [this.now()])
        await this.session.Execute(SqlOidcFlowStateStore.PutSql, [state.State, state.Nonce, state.CodeVerifier, state.RedirectUri, state.ExpiresAt, state.ReturnPath])
    }

    public async Take(state: string): Promise<OidcFlowState | null>
    {
        const row = (await this.session.Query(SqlOidcFlowStateStore.TakeSql, [state]))[0]
        if (row === undefined)
        {
            return null
        }
        const taken = SqlOidcFlowStateStore.ToState(row)
        return this.now().getTime() >= taken.ExpiresAt.getTime() ? null : taken
    }

    private static ToState(row: SqlRow): OidcFlowState
    {
        return new OidcFlowState(String(row.state), String(row.nonce), String(row.code_verifier), String(row.redirect_uri), new Date(row.expires_at as string | Date), row.return_path === null || row.return_path === undefined ? null : String(row.return_path))
    }
}
