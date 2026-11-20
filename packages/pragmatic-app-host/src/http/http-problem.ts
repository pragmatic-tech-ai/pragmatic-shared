/** An error that is its own HTTP answer: a handler throws it and the ProblemMapper writes `status` with `message`.
 *  Its message is shown to the caller, so it must never carry secret material. */
export class HttpProblem extends Error
{
    private static readonly ErrorName = 'HttpProblem'

    public constructor(public readonly Status: number, message: string)
    {
        super(message)
        this.name = HttpProblem.ErrorName
    }
}

/** 400: the request body or parameters are not what the route reads. */
export class BadRequestProblem extends HttpProblem
{
    private static readonly StatusBadRequest = 400
    public static readonly InvalidJsonMessage = 'Invalid JSON body'
    public static readonly ObjectRequiredMessage = 'Body must be a JSON object'

    public constructor(message: string)
    {
        super(BadRequestProblem.StatusBadRequest, message)
    }
}
