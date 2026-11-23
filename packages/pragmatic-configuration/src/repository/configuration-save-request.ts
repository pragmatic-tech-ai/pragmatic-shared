import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import type { ConfigurationScope } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';

/**
 * A new configuration version: the document (as authored), the descriptor of the container version it will run with,
 * the version it was edited from (`BasedOn`; 0 for the first version), the author (a realm subject) and a comment.
 */
export class ConfigurationSaveRequest
{
    public constructor(
        public readonly Scope: ConfigurationScope,
        public readonly BasedOn: number,
        public readonly Document: unknown,
        public readonly Descriptor: ComponentDescriptor,
        public readonly Author: string,
        public readonly Comment: string,
    )
    {
        Object.freeze(this);
    }
}
