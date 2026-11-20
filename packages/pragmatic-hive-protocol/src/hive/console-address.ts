import { DecodeReason } from '../wire/protocol-decode-error.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'

/** Where the hive's console is reached (levels design §6b): the customer's choice at install. */
export enum ConsoleAddressOption
{
    /** Their own domain: their DNS, their certificate, straight to their ingress. */
    OwnDomain = 'own-domain',
    /** `<name>.hives.pragmatic-tech.ai` pointing at the ingress address the hive reports. */
    HiveSubdomain = 'hive-subdomain',
    /** `<name>.hives.pragmatic-tech.ai` for a private cluster: pointing at the edge, relayed through the agent's tunnel. */
    RelayedHiveSubdomain = 'relayed-hive-subdomain',
}

export interface ConsoleAddressJson
{
    Option: ConsoleAddressOption
    HostName: string
    IngressAddress: string | null
}

/**
 * The console address a hive reports at enrolment. On our subdomain the host name is one label under
 * `hives.pragmatic-tech.ai`; the plain subdomain carries the ingress address we publish a record to, the relayed one
 * none (the record points at the edge), and their own domain none (their DNS).
 */
export class ConsoleAddress
{
    public static readonly HiveDomain = 'hives.pragmatic-tech.ai'
    public static readonly Options: readonly ConsoleAddressOption[] = Object.values(ConsoleAddressOption)
    private static readonly DomainSeparator = '.'
    private static readonly Field = { Option: 'Option', HostName: 'HostName', IngressAddress: 'IngressAddress' } as const
    private static readonly Members: readonly string[] = Object.values(ConsoleAddress.Field)

    private constructor(public readonly Option: ConsoleAddressOption, public readonly HostName: string, public readonly IngressAddress: string | null)
    {
    }

    public static OwnDomain(hostName: string): ConsoleAddress
    {
        return ConsoleAddress.Parse({ Option: ConsoleAddressOption.OwnDomain, HostName: hostName, IngressAddress: null })
    }

    public static HiveSubdomain(name: string, ingressAddress: string): ConsoleAddress
    {
        return ConsoleAddress.Parse({ Option: ConsoleAddressOption.HiveSubdomain, HostName: ConsoleAddress.SubdomainOf(name), IngressAddress: ingressAddress })
    }

    public static RelayedHiveSubdomain(name: string): ConsoleAddress
    {
        return ConsoleAddress.Parse({ Option: ConsoleAddressOption.RelayedHiveSubdomain, HostName: ConsoleAddress.SubdomainOf(name), IngressAddress: null })
    }

    /** `<name>.hives.pragmatic-tech.ai`. */
    public static SubdomainOf(name: string): string
    {
        return name + ConsoleAddress.DomainSeparator + ConsoleAddress.HiveDomain
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): ConsoleAddress
    {
        const C = ConsoleAddress
        const F = C.Field
        const fields = StrictFields.Exactly(value, C.Members, path)
        const option = fields.Enum(F.Option, C.Options)
        const hostName = fields.String(F.HostName, { Max: 253, Pattern: ProtocolNames.HostName })
        const ingress = fields.NullableString(F.IngressAddress, { Max: 253 })
        if (ingress !== null && !ProtocolNames.IsAddress(ingress))
        {
            throw fields.Refuse(F.IngressAddress, DecodeReason.BadFormat)
        }
        const ours = C.IsHiveSubdomain(hostName)
        const subdomainOption = option !== ConsoleAddressOption.OwnDomain
        if (ours !== subdomainOption)
        {
            throw fields.Refuse(F.HostName, DecodeReason.Inconsistent)
        }
        if ((ingress !== null) !== (option === ConsoleAddressOption.HiveSubdomain))
        {
            throw fields.Refuse(F.IngressAddress, DecodeReason.Inconsistent)
        }
        return new ConsoleAddress(option, hostName, ingress)
    }

    /** Whether `hostName` is exactly one label under the hive domain. */
    public static IsHiveSubdomain(hostName: string): boolean
    {
        const suffix = ConsoleAddress.DomainSeparator + ConsoleAddress.HiveDomain
        return hostName.endsWith(suffix) && ProtocolNames.Label.test(hostName.slice(0, -suffix.length))
    }

    public ToJson(): ConsoleAddressJson
    {
        return { Option: this.Option, HostName: this.HostName, IngressAddress: this.IngressAddress }
    }
}
