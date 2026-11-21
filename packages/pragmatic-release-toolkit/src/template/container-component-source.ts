import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import type { IReleaseComponentSource } from '../release/component-descriptor-cli.js'
import type { ReleaseApp } from '../release/release-tag.js'

/**
 * A container repository's one component, as the `pragmatic-component-descriptors --components <module>` command reads
 * it: the repository's `src/release-components.ts` (compiled to the module the rendered Dockerfile names) exports
 * `Components = new ContainerComponentSource(ReleaseApp.<App>, () => <App>Component.Descriptor())`.
 */
export class ContainerComponentSource implements IReleaseComponentSource
{
    private static readonly OtherAppPrefix = 'Not this repository\'s component: '
    private static readonly DeclaresInfix = ' (it declares '
    private static readonly MisnamedPrefix = 'The descriptor is named '
    private static readonly NotInfix = ', not '
    private static readonly Close = ')'

    public constructor(private readonly app: ReleaseApp, private readonly descriptor: () => ComponentDescriptor)
    {
    }

    public Of(app: ReleaseApp): ComponentDescriptor
    {
        const S = ContainerComponentSource
        if (app !== this.app)
        {
            throw new Error(S.OtherAppPrefix + app + S.DeclaresInfix + this.app + S.Close)
        }
        const descriptor = this.descriptor()
        if (descriptor.Name !== this.app)
        {
            throw new Error(S.MisnamedPrefix + descriptor.Name + S.NotInfix + this.app)
        }
        return descriptor
    }

    public All(): [ReleaseApp, ComponentDescriptor][]
    {
        return [[this.app, this.Of(this.app)]]
    }
}
