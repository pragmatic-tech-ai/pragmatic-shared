/** How a person signs in to an application. */
export enum SignInMethod
{
    /** A redirect to the realm's sign-in service (`OidcLoginEndpoint` begin). The default, and the only one most applications offer. */
    Oidc = 'oidc',
    /** A local password (`PasswordLoginEndpoint`): the platform admin console's break-glass operator accounts. */
    Password = 'password',
}
