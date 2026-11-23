import type { IncomingMessage } from 'node:http'
import type { SessionStore } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { ITenantDirectory } from '../tenant-api/tenant-directory.js'
import { RealmDesktopBearer } from './realm-desktop-bearer.js'
import { TenantSessionRules } from './tenant-session-gate.js'
import { TenantSessionClaims, TenantSessionKind, type TenantSession } from './tenant-sessions.js'

/**
 * The desktop authentication gate. It reads only `Authorization: Bearer <token>` (cookies are ignored, so a console
 * cookie can never act as a desktop credential) and accepts two bearer kinds: a realm access token (three JWS segments,
 * when the console has its realm: `RealmDesktopBearer`, E spec S5) and a desktop session of the console's own store (the
 * transitional console-brokered sign-in). Either is returned only when it is a live desktop session (TenantSessionRules:
 * its tenant exists and was not re-created after the session was issued, so a deleted tenant's bearer never reaches a
 * later tenant of the same id; roles refreshed); an expired or invalid one is no session, without detail. The token is a
 * secret: it is never logged, echoed, or placed in an error.
 */
export class DesktopAuthGate
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPattern = /^Bearer ([^\s]+)$/i
    private readonly rules: TenantSessionRules

    public constructor(
        private readonly sessions: SessionStore,
        tenants: Pick<ITenantDirectory, 'GetTenant'>,
        /** The console's realm bearers (the in-hive console); absent, only stored desktop sessions are bearers. */
        private readonly realm?: RealmDesktopBearer)
    {
        this.rules = new TenantSessionRules(tenants)
    }

    /** Whether the request's bearer is a realm access token (signing out ends no stored session for it). */
    public IsRealmBearer(req: IncomingMessage): boolean
    {
        const token = DesktopAuthGate.Token(req)
        return this.realm !== undefined && token !== null && RealmDesktopBearer.IsJwt(token)
    }

    /** The bearer token the request carries, or null. */
    public static Token(req: IncomingMessage): string | null
    {
        const header = req.headers[DesktopAuthGate.AuthorizationHeader]
        const match = typeof header === 'string' ? DesktopAuthGate.BearerPattern.exec(header) : null
        return match === null ? null : match[1] as string
    }

    public async Principal(req: IncomingMessage): Promise<TenantSession | null>
    {
        const token = DesktopAuthGate.Token(req)
        if (token === null)
        {
            return null
        }
        const presented = this.realm !== undefined && RealmDesktopBearer.IsJwt(token) ? await this.realm.SessionOf(token) : await this.sessions.Validate(token)
        const record = this.rules.Admit(presented, TenantSessionKind.Desktop)
        return record === null ? null : TenantSessionClaims.ViewOf(record) ?? null
    }
}
