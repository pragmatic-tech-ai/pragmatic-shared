/** A container repository render that cannot be made: a bad option, a bad workspaces field or a template gap. */
export class ContainerTemplateError extends Error
{
    private static readonly ErrorName = 'ContainerTemplateError'

    public constructor(message: string)
    {
        super(message)
        this.name = ContainerTemplateError.ErrorName
    }
}
