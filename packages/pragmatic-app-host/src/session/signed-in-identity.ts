import type { SessionClaims } from './session-claims.js'

/** Who a sign-in method established: the realm's subject id and what the realm said about them. A session is issued
 *  for it. */
export class SignedInIdentity
{
    public constructor(public readonly Subject: string, public readonly Claims: SessionClaims)
    {
    }
}
