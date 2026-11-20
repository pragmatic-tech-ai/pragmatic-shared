/**
 * An Identity Platform REST failure. Code is Identity Platform's error code (EMAIL_EXISTS, WEAK_PASSWORD,
 * INVALID_LOGIN_CREDENTIALS, TOO_MANY_ATTEMPTS_TRY_LATER, INVALID_IDP_RESPONSE, ...), the part of the error message
 * before " : ".
 */
export class IdentityPlatformRestError extends Error
{
    private static readonly DetailSeparator = " : ";
    private static readonly UnknownCode = "UNKNOWN";
    private static readonly MessagePrefix = "Identity Platform: ";

    public constructor(public readonly Code: string, public readonly Status: number, detail: string)
    {
        super(IdentityPlatformRestError.MessagePrefix + detail);
    }

    /** From an error answer's body (`{ error: { message } }`). */
    public static FromBody(status: number, body: unknown): IdentityPlatformRestError
    {
        const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
        if (typeof message !== "string" || message === "")
        {
            return new IdentityPlatformRestError(IdentityPlatformRestError.UnknownCode, status, IdentityPlatformRestError.UnknownCode);
        }
        return IdentityPlatformRestError.FromMessage(status, message);
    }

    /** From an Identity Platform error message (`CODE` or `CODE : detail`). */
    public static FromMessage(status: number, message: string): IdentityPlatformRestError
    {
        const separator = message.indexOf(IdentityPlatformRestError.DetailSeparator);
        return new IdentityPlatformRestError(separator < 0 ? message : message.slice(0, separator), status, message);
    }
}
