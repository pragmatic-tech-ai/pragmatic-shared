import type { RealmTokenPrincipal } from "./realm-token-principal.js";

/**
 * Verifies a bearer token a realm issued (an ID token of its issuer) and names who it is for. Answers undefined for a
 * token that is not valid; throws TokenVerifierUnavailableError only when it cannot decide (the issuer's discovery
 * document or keys unreachable or unusable).
 */
export interface IRealmTokenVerifier
{
    Verify(token: string): Promise<RealmTokenPrincipal | undefined>;
}
