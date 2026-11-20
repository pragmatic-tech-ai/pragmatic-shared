/** A request body exceeded its route's size limit (answered as 413 once the body has drained). */
export class BodyTooLargeError extends Error
{
    private static readonly ErrorName = 'BodyTooLargeError'
    public static readonly DefaultMessage = 'Request body too large'

    public constructor(message: string = BodyTooLargeError.DefaultMessage)
    {
        super(message)
        this.name = BodyTooLargeError.ErrorName
    }
}
