import { OidcIdentityProviderPackBase } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import type { OidcPackOptions } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import { PragmaticIdentityProfile } from "./pragmatic-identity-profile.js";

export type PragmaticIdentityPackOptions = Omit<OidcPackOptions, "Profile">;

/**
 * "Sign in with Pragmatic" pack: the central realm as an OIDC upstream.
 *
 * PR7: the central realm exposes no directory API to its relying parties, so an account disabled there keeps access
 * here until the current session expires.
 */
export class PragmaticIdentityPack extends OidcIdentityProviderPackBase
{
    public static Create(opts: PragmaticIdentityPackOptions): PragmaticIdentityPack
    {
        return new PragmaticIdentityPack({ Profile: new PragmaticIdentityProfile(), ...opts });
    }
}
