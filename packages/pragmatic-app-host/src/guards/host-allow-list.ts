import type { IncomingMessage } from 'node:http'

/** The Host names an application answers on (DNS-rebinding guard): the Host header, port stripped and lowercased,
 *  must be one of them. */
export class HostAllowList
{
    private static readonly HostHeaderPattern = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/
    private static readonly HostHeader = 'host'
    private static readonly ListSeparator = ','
    private static readonly LoopbackHosts: readonly string[] = ['localhost', '127.0.0.1', '[::1]']

    public readonly Hosts: ReadonlySet<string>

    public constructor(hosts: Iterable<string>)
    {
        this.Hosts = new Set([...hosts].map(host => host.trim().toLowerCase()).filter(host => host.length > 0))
    }

    /** The configured hosts plus the loopback names (a local run and the image's own health dial). */
    public static WithLoopback(hosts: Iterable<string> = []): HostAllowList
    {
        return new HostAllowList([...HostAllowList.LoopbackHosts, ...hosts])
    }

    /** Hosts from a comma-separated setting (an environment variable); absent is empty. */
    public static Parse(list: string | undefined): HostAllowList
    {
        return new HostAllowList((list ?? '').split(HostAllowList.ListSeparator))
    }

    public Allows(req: IncomingMessage): boolean
    {
        const host = HostAllowList.HostName(req.headers[HostAllowList.HostHeader])
        return host !== undefined && this.Hosts.has(host)
    }

    /** The lowercased, port-stripped host of a Host header, or undefined when absent or unparseable. */
    public static HostName(hostHeader: string | undefined): string | undefined
    {
        const match = hostHeader === undefined ? null : HostAllowList.HostHeaderPattern.exec(hostHeader)
        return match === null ? undefined : (match[1] as string).toLowerCase()
    }

    /** The Host header's port; undefined when it carries none (or is malformed). */
    public static HostPort(hostHeader: string | undefined): number | undefined
    {
        const match = hostHeader === undefined ? null : HostAllowList.HostHeaderPattern.exec(hostHeader)
        return match === null || match[2] === undefined ? undefined : Number(match[2])
    }
}
