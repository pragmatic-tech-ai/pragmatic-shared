import type { SignedInIdentity } from '../session/signed-in-identity.js'

/** An application's local password check (the platform admin console's break-glass operator accounts): the identity
 *  when the password is right, else null. Never throws for a wrong password; never logs the password. */
export interface IPasswordAuthenticator
{
    Authenticate(account: string, password: string): Promise<SignedInIdentity | null>
}
