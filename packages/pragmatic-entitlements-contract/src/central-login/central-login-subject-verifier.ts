import type { IRealmTokenVerifier } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { CentralLoginSubject } from './central-login-subject.js'
import type { ICentralLoginVerifier } from './central-login-verifier.js'

/**
 * The ICentralLoginVerifier over a realm token verifier (pragmatic-identity-source-pragmatic's
 * CentralLoginTokenVerifier, or a RealmTokenVerifier for a configured issuer): a verified token whose principal has an
 * email and forms a well-formed CentralLoginSubject names the customer; anything else is undefined. The token
 * verifier's TokenVerifierUnavailableError (it cannot decide) passes through.
 */
export class CentralLoginSubjectVerifier implements ICentralLoginVerifier
{
    public constructor(private readonly tokens: IRealmTokenVerifier)
    {
    }

    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        const principal = await this.tokens.Verify(token)
        if (principal === undefined || principal.Email === undefined)
        {
            return undefined
        }
        try
        {
            return CentralLoginSubject.Of(principal.Issuer, principal.Subject, principal.Email)
        }
        catch
        {
            return undefined
        }
    }
}
