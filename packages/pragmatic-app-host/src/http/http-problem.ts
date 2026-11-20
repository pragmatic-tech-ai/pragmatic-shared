/** An error that is its own HTTP answer: a handler throws it and the ProblemMapper writes `status` with `message`,
 *  plus `Fields()` (the `code` a caller switches on, when there is one). Its message and fields are shown to the
 *  caller, so they must never carry secret material. */
export class HttpProblem extends Error
{
    private static readonly ErrorName = 'HttpProblem'
    public static readonly CodeField = 'code'

    public constructor(public readonly Status: number, message: string, public readonly Code?: string)
    {
        super(message)
        this.name = HttpProblem.ErrorName
    }

    /** The JSON members written beside `error`: `code` when set; a subclass may add its own. */
    public Fields(): Record<string, unknown>
    {
        return this.Code === undefined ? {} : { [HttpProblem.CodeField]: this.Code }
    }
}

/** 400: the request body or parameters are not what the route reads. Code `invalid-request`. */
export class BadRequestProblem extends HttpProblem
{
    private static readonly StatusBadRequest = 400
    public static readonly InvalidRequestCode = 'invalid-request'
    public static readonly InvalidJsonMessage = 'Invalid JSON body'
    public static readonly ObjectRequiredMessage = 'Body must be a JSON object'

    public constructor(message: string)
    {
        super(BadRequestProblem.StatusBadRequest, message, BadRequestProblem.InvalidRequestCode)
    }
}
