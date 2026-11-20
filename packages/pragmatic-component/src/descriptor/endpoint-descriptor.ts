import { JsonValue } from './canonical-json.js';
import { DescriptorKeys } from './descriptor-keys.js';

/** A named TCP port the component listens on. */
export class PortDescriptor
{
    public constructor(
        public readonly Name: string,
        public readonly Number: number,
    )
    {
        Object.freeze(this);
    }

    public ToJson(): Record<string, JsonValue>
    {
        return { [DescriptorKeys.Name]: this.Name, [DescriptorKeys.Port]: this.Number };
    }
}

/** The HTTP health endpoint: a path served on one of the declared ports. */
export class HealthEndpoint
{
    public constructor(
        public readonly Port: string,
        public readonly Path: string,
    )
    {
        Object.freeze(this);
    }

    public ToJson(): Record<string, JsonValue>
    {
        return { [DescriptorKeys.Port]: this.Port, [DescriptorKeys.Path]: this.Path };
    }
}

/** The ports the component serves and its health endpoint, if it has one. */
export class EndpointDescriptor
{
    public readonly Ports: readonly PortDescriptor[];

    public constructor(
        ports: readonly PortDescriptor[],
        public readonly Health: HealthEndpoint | undefined,
    )
    {
        this.Ports = Object.freeze([...ports]);
        Object.freeze(this);
    }

    public ToJson(): Record<string, JsonValue>
    {
        const json: Record<string, JsonValue> = { [DescriptorKeys.Ports]: this.Ports.map(port => port.ToJson()) };
        if (this.Health !== undefined) json[DescriptorKeys.Health] = this.Health.ToJson();
        return json;
    }
}
