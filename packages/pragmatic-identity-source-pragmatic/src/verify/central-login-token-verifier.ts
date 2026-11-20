import { RealmTokenVerifier } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import type { RealmTokenVerifierOptions } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import { PragmaticIdentityProfile } from "../packs/pragmatic-identity-profile.js";

/** The central preset's options: the realm-generic ones, with the issuer optional. */
export type CentralLoginTokenVerifierOptions = Omit<RealmTokenVerifierOptions, "Issuer"> & { Issuer?: string };

/**
 * Verifies a token of the central login ("Sign in with Pragmatic"): the realm-generic RealmTokenVerifier preset to the
 * central realm's issuer (`https://login.pragmatic-tech.ai/realms/central`, overridable for tests and development
 * stacks) and requiring an email, which names the customer. The audience is the relying party's client id at the
 * central realm (the personal cabinet's, the platform admin console's, the ledger's).
 */
export class CentralLoginTokenVerifier extends RealmTokenVerifier
{
    public static readonly Issuer = PragmaticIdentityProfile.CentralIssuer;

    public constructor(options: CentralLoginTokenVerifierOptions)
    {
        super({ ...options, Issuer: options.Issuer ?? CentralLoginTokenVerifier.Issuer, RequireEmail: options.RequireEmail ?? true });
    }
}
