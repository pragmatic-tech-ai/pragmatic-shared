/** A component descriptor that breaks a rule (built or decoded). */
export class ComponentDescriptorError extends Error
{
    private static readonly Placeholder = /\{(\d+)\}/g;

    public constructor(message: string)
    {
        super(message);
        this.name = ComponentDescriptorError.name;
    }

    /** The error with `{0}`, `{1}`, ... in the message template replaced by the arguments. */
    public static Of(template: string, ...args: (string | number)[]): ComponentDescriptorError
    {
        return new ComponentDescriptorError(template.replace(ComponentDescriptorError.Placeholder, (_, index: string) => String(args[Number(index)])));
    }
}
