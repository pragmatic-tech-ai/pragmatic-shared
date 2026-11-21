import type { IncomingMessage } from 'node:http'
import type { OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { OidcRelyingParty } from '../oidc-relying-party.js'
import type { IOidcClientProvider } from '../oidc-client-config.js'
import { OidcLoginError } from '../oidc-login-error.js'
import type { SessionTokenVault } from './session-token-vault.js'
import { SealedSessionTokens } from './session-token-repository.js'
import type { ISessionTokenRepository } from './session-token-repository.js'
import { SessionStore } from '../../session/session-store.js'
import { SessionPolicy } from '../../session/session-policy.js'
import type { IssuedSession } from '../../session/session-record.js'

export interface SessionTokenRetentionOptions
{
    /** Seals the tokens under the application's key and the session's bearer. */
    Vault: SessionTokenVault
    /** SqlSessionTokenRepository in production, so every replica sees a refresh. */
    Repository: ISessionTokenRepository
    /** Redeems refresh tokens. */
    RelyingParty: OidcRelyingParty
    /** The client a request's refresh runs under (the one its sign-in ran under). */
    Clients: IOidcClientProvider
    /** Tokens count as due this long before they expire, so a forwarded token is never about to; default 30 s. */
    ExpiryMarginMs?: number
    /** Without a refresh token the session ends when the ID token does (less the margin); default true. False keeps the
     *  sign-in endpoint's policy, and handlers then get no tokens once the ID token has expired. */
    EndWithIdToken?: boolean
    Now?: () => Date
}

/**
 * Opt-in retention of the upstream tokens an OIDC sign-in returned (the ID token, and the access token if issued),
 * for applications whose route handlers call downstream services on the signed-in subject's behalf. The tokens are
 * kept server-side beside the session, sealed (SessionTokenVault); the browser never sees them. Handlers reach them
 * through the session gate (SessionGate.UpstreamTokens). When the issuer gave a refresh token, due tokens are refreshed
 * (once per session at a time) and re-sealed; otherwise the session lives exactly as long as the ID token
 * (configurable). Logout forgets them; expired rows are swept on each Keep.
 */
export class SessionTokenRetention
{
    private static readonly DefaultExpiryMarginMs = 30_000

    private readonly marginMs: number
    private readonly endWithIdToken: boolean
    private readonly now: () => Date
    private readonly refreshing = new Map<string, Promise<OidcTokenSet | null>>()

    public constructor(private readonly options: SessionTokenRetentionOptions)
    {
        this.marginMs = options.ExpiryMarginMs ?? SessionTokenRetention.DefaultExpiryMarginMs
        this.endWithIdToken = options.EndWithIdToken ?? true
        this.now = options.Now ?? (() => new Date())
    }

    /**
     * The policy a session signed in with `tokens` is issued under: `fallback` when the tokens can be refreshed (or the
     * session is not tied to the ID token), else one that ends with the ID token. Throws OidcLoginError when the ID token
     * is already within the margin of its expiry.
     */
    public PolicyFor(tokens: OidcTokenSet, fallback: SessionPolicy | undefined): SessionPolicy | undefined
    {
        const ttl = tokens.IdTokenExpiresAt.getTime() - this.marginMs - this.now().getTime()
        if (ttl <= 0)
        {
            throw new OidcLoginError()
        }
        return tokens.Refreshable || !this.endWithIdToken ? fallback : new SessionPolicy(ttl)
    }

    /** Seals the sign-in's tokens beside the session just issued, for as long as the session can live. */
    public async Keep(issued: IssuedSession, tokens: OidcTokenSet): Promise<void>
    {
        await this.options.Repository.DeleteExpired(this.now()).catch(() => 0)
        const session = issued.Session
        const expiresAt = new Date(Math.max(session.ExpiresAt.getTime(), session.IssuedAt.getTime() + session.Policy.MaxLifetimeMs))
        await this.options.Repository.Put(new SealedSessionTokens(session.Id, this.options.Vault.Seal(issued.Token, tokens), expiresAt))
    }

    /** The live tokens of the session `bearer` names, refreshed when due and refreshable; null when there are none. */
    public async Current(req: IncomingMessage, bearer: string): Promise<OidcTokenSet | null>
    {
        const sessionId = SessionStore.DigestOf(bearer)
        const row = await this.options.Repository.Find(sessionId)
        if (row === undefined || row.SessionId !== sessionId || row.ExpiresAt.getTime() <= this.now().getTime())
        {
            return null
        }
        const tokens = this.options.Vault.Open(bearer, row.Sealed)
        if (tokens === undefined)
        {
            return null
        }
        if (!this.IsDue(tokens.ExpiresAt))
        {
            return tokens
        }
        if (tokens.Refreshable)
        {
            return await this.RefreshOnce(req, bearer, row, tokens)
        }
        return this.IsDue(tokens.IdTokenExpiresAt) ? null : tokens
    }

    /** The stored tokens of the session `bearer` names, as sealed: no expiry check and no refresh (nothing is written,
     *  the IdP is not called), e.g. the ID token a logout sends as `id_token_hint`; null when there are none. */
    public async Peek(bearer: string): Promise<OidcTokenSet | null>
    {
        const sessionId = SessionStore.DigestOf(bearer)
        const row = await this.options.Repository.Find(sessionId)
        if (row === undefined || row.SessionId !== sessionId)
        {
            return null
        }
        return this.options.Vault.Open(bearer, row.Sealed) ?? null
    }

    /** Drops the session's tokens (its session ended). */
    public async Forget(bearer: string): Promise<void>
    {
        await this.options.Repository.Delete(SessionStore.DigestOf(bearer))
    }

    private IsDue(expiresAt: Date): boolean
    {
        return expiresAt.getTime() - this.marginMs <= this.now().getTime()
    }

    // Concurrent requests of one session share one refresh, so a rotating issuer sees each refresh token redeemed once.
    private RefreshOnce(req: IncomingMessage, bearer: string, row: SealedSessionTokens, tokens: OidcTokenSet): Promise<OidcTokenSet | null>
    {
        let pending = this.refreshing.get(row.SessionId)
        if (pending === undefined)
        {
            pending = this.Refresh(req, bearer, row, tokens).finally(() => this.refreshing.delete(row.SessionId))
            this.refreshing.set(row.SessionId, pending)
        }
        return pending
    }

    private async Refresh(req: IncomingMessage, bearer: string, row: SealedSessionTokens, tokens: OidcTokenSet): Promise<OidcTokenSet | null>
    {
        try
        {
            const client = await this.options.Clients.ClientFor(req)
            const fresh = await this.options.RelyingParty.Refresh(client, tokens.RefreshToken as string, tokens.Subject)
            if (fresh === null || this.IsDue(fresh.ExpiresAt))
            {
                return null
            }
            await this.options.Repository.Put(new SealedSessionTokens(row.SessionId, this.options.Vault.Seal(bearer, fresh), row.ExpiresAt))
            return fresh
        }
        catch
        {
            return null
        }
    }
}
