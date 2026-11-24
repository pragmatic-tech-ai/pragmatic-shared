import type { RealmSecretsOption } from './realm-secrets-option.js'

/** Why a realm's secrets home did not answer. Never the cloud's own text: it can carry identifiers and request ids. */
export enum SecretsHomeFailure
{
    /** The projected service-account token could not be read (missing, empty, unreadable). */
    TokenUnreadable = 'token-unreadable',
    /** The cloud refused to exchange the token for credentials (audience, issuer, binding). */
    ExchangeRefused = 'exchange-refused',
    /** The home itself (project, vault, database) does not exist. A missing secret is not a failure: it reads absent. */
    NotFound = 'not-found',
    /** The credentials work but may not do this (an IAM binding, a vault policy, a database role). */
    PermissionDenied = 'permission-denied',
    /** The home could not be reached or answered with an unexpected status. */
    Unreachable = 'unreachable',
    /** The custom home's rows (its key check, or a sealed secret) do not open with the mounted realm master key. */
    KeyMismatch = 'key-mismatch',
    /** The custom home's master key file is missing, unreadable or not a 32-byte key. */
    KeyUnreadable = 'key-unreadable',
}

/** A realm's secrets home failed to answer. The message names the option and the code only. */
export class SecretsHomeUnavailableError extends Error
{
    public static readonly ErrorName = 'SecretsHomeUnavailableError'
    private static readonly Prefix = "the realm's secrets home ("
    private static readonly Infix = ') is unavailable: '

    /** The code again under Node's `code` convention, so generic error reporting shows it. */
    public readonly code: string

    public constructor(public readonly Option: RealmSecretsOption, public readonly Code: SecretsHomeFailure)
    {
        super(SecretsHomeUnavailableError.Prefix + Option + SecretsHomeUnavailableError.Infix + Code)
        this.name = SecretsHomeUnavailableError.ErrorName
        this.code = Code
    }

    public static Is(error: unknown): error is SecretsHomeUnavailableError
    {
        return error instanceof SecretsHomeUnavailableError
    }
}
