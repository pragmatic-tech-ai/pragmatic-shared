import type { CentralLoginSubject } from './central-login-subject.js'

/**
 * Verifies a customer's central-login token (an ID token of the central login's issuer: signature on its JWKS,
 * audience, expiry) and names its subject. Supplied by the application (built on pragmatic-identity-source-oidc);
 * answers undefined for a token that is not valid, and throws only when it cannot decide (e.g. the JWKS is unreachable).
 */
export interface ICentralLoginVerifier
{
    Verify(token: string): Promise<CentralLoginSubject | undefined>
}
