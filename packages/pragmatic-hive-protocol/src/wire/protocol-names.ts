/**
 * The shapes of every name and token the protocol carries. Each is a closed character set with a length bound, so no
 * member can hold free text: a log line, an error message or environment data cannot fit any of them.
 */
export class ProtocolNames
{
    /** A DNS label: hive, host, placement, intent and environment ids. */
    public static readonly Label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
    /** A tenant id (the customer API's shape): 3-32 characters, starting with a letter. */
    public static readonly Tenant = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/
    /** A component name: at most 46 characters, so `pragmatic-config-<component>` stays one DNS label. */
    public static readonly Component = /^[a-z][a-z0-9-]{0,45}$/
    /** A semantic version, at most 64 characters. */
    public static readonly Version = /^(?=.{5,64}$)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
    /** A content digest: `sha256:` and 64 lowercase hex digits. */
    public static readonly Digest = /^sha256:[a-f0-9]{64}$/
    /** A fully qualified host name (an SNI name, a console or mesh address): lowercase labels, at least two, the last
     *  starting with a letter (so no IP address reads as a name). */
    public static readonly HostName = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
    /** An IPv4 address in dotted decimal. */
    public static readonly Ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
    /** An IPv6 address in lowercase hex groups (no zone, no embedded IPv4). */
    public static readonly Ipv6 = /^(?=.{2,39}$)[0-9a-f:]*:[0-9a-f:]*$/
    /** A one-time enrolment code (the customer API's shape). */
    public static readonly EnrolmentCode = /^[A-Za-z0-9_-]{16,128}$/
    /** A nonce: 16 to 48 random bytes, base64url. */
    public static readonly Nonce = /^[A-Za-z0-9_-]{22,64}$/
    /** A realm subject (the `sub` of a realm sign-in): printable ASCII, no spaces. */
    public static readonly Subject = /^[\x21-\x7e]{1,255}$/
    /** A reference into the platform's secret store, e.g. `clusters/<placement>/r3`. */
    public static readonly CredentialReference = /^[a-z0-9](?:[a-z0-9./-]{0,126}[a-z0-9])?$/
    /** The channel URL: https only, printable ASCII. */
    public static readonly HttpsUrl = /^https:\/\/[\x21-\x7e]{3,2040}$/
    public static readonly MaxPort = 65535

    /** A host name or an IP address. */
    public static IsAddress(value: string): boolean
    {
        return ProtocolNames.HostName.test(value) || ProtocolNames.Ipv4.test(value) || ProtocolNames.Ipv6.test(value)
    }
}
