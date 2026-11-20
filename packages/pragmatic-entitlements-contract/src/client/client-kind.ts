/** What a client is. One model for both: the kind matters only for how they pay, which Paddle handles. */
export enum ClientKind
{
    Organisation = 'organisation',
    Person = 'person',
}

/** The fixed set of client kinds and the shape of a client id. */
export class ClientKinds
{
    public static readonly All: readonly ClientKind[] = Object.values(ClientKind)
    /** A client id (and a plan id): lowercase letters, digits and inner `-`, 1-63 characters (DNS label shape). */
    public static readonly IdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
    public static readonly MaxNameLength = 200
}
