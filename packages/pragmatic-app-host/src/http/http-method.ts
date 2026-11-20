/** The HTTP methods a route can declare. */
export enum HttpMethod
{
    Get = 'GET',
    Head = 'HEAD',
    Options = 'OPTIONS',
    Post = 'POST',
    Put = 'PUT',
    Patch = 'PATCH',
    Delete = 'DELETE',
}

/** Method classification shared by the pipeline: a method is a mutation unless it is explicitly safe, so PATCH and
 *  unknown verbs are mutations (deny-by-default for read-only roles and the Origin guard). */
export class HttpMethods
{
    private static readonly Safe: ReadonlySet<string> = new Set([HttpMethod.Get, HttpMethod.Head, HttpMethod.Options])
    private static readonly Known: ReadonlyMap<string, HttpMethod> = new Map(Object.values(HttpMethod).map(method => [method as string, method]))

    public static IsMutating(method: string): boolean
    {
        return !HttpMethods.Safe.has(method.toUpperCase())
    }

    public static Parse(method: string | undefined): HttpMethod | undefined
    {
        return method === undefined ? undefined : HttpMethods.Known.get(method.toUpperCase())
    }
}
