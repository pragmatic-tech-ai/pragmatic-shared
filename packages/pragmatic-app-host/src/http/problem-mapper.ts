import type { ServerResponse } from 'node:http'
import { BodyTooLargeError } from './body-too-large-error.js'
import { HttpProblem } from './http-problem.js'
import { JsonApi } from './json-api.js'

/** An error class the mapper can register (any constructor of an Error). */
export type ProblemErrorClass = abstract new (...args: never[]) => Error

/** Extra JSON fields an error class adds to its answer (e.g. a code the UI switches on). Never secret material. */
export type ProblemBody = (err: Error) => Record<string, unknown>

/** One registered error class: its status, whether a 5xx shows its message, and its extra fields. */
class ProblemMapping
{
    public constructor(public readonly ErrorClass: ProblemErrorClass, public readonly Status: number, public readonly Unmasked: boolean, public readonly Body: ProblemBody | undefined)
    {
    }
}

/**
 * Error class -> HTTP status registry: the WriteError mechanism of the console hosts, without their domain table (each
 * application registers its own). Built in: BodyTooLargeError is 413 and an HttpProblem answers its own status. A
 * registered class answers its status with `{ error: message, ...Body(err) }`; a subclass maps through its nearest
 * registered parent. Anything else, and a registered 5xx other than 503 that is not registered unmasked, is logged
 * and answered as a generic 500 whose text carries nothing of the error. After the headers were sent the response is
 * only ended.
 */
export class ProblemMapper
{
    private static readonly StatusInternal = 500
    private static readonly StatusUnavailable = 503
    private static readonly StatusTooLarge = 413
    public static readonly GenericMessage = 'Operation failed'
    private static readonly ErrorField = 'error'

    private readonly mappings: ProblemMapping[] = []

    /** `log` receives every error answered as a generic 500 (the only place its detail goes). */
    public constructor(private readonly log: (err: unknown) => void)
    {
    }

    public Register(errorClass: ProblemErrorClass, status: number, body?: ProblemBody): this
    {
        this.mappings.push(new ProblemMapping(errorClass, status, false, body))
        return this
    }

    /** Registers a 5xx class whose message is a fixed, safe sentence the caller should see (e.g. an upstream outage). */
    public RegisterUnmasked(errorClass: ProblemErrorClass, status: number, body?: ProblemBody): this
    {
        this.mappings.push(new ProblemMapping(errorClass, status, true, body))
        return this
    }

    public Write(res: ServerResponse, err: unknown): void
    {
        if (res.headersSent)
        {
            res.end()
            return
        }
        if (err instanceof BodyTooLargeError)
        {
            JsonApi.WriteJson(res, ProblemMapper.StatusTooLarge, { [ProblemMapper.ErrorField]: err.message })
            return
        }
        if (err instanceof HttpProblem)
        {
            JsonApi.WriteJson(res, err.Status, { ...err.Fields(), [ProblemMapper.ErrorField]: err.message })
            return
        }
        const mapping = err instanceof Error ? this.MappingFor(err) : undefined
        if (mapping === undefined || ProblemMapper.Masked(mapping))
        {
            this.log(err)
            JsonApi.WriteJson(res, ProblemMapper.StatusInternal, { [ProblemMapper.ErrorField]: ProblemMapper.GenericMessage })
            return
        }
        const error = err as Error
        JsonApi.WriteJson(res, mapping.Status, { [ProblemMapper.ErrorField]: error.message, ...(mapping.Body?.(error) ?? {}) })
    }

    /** The status `err` would be answered with. */
    public StatusOf(err: unknown): number
    {
        if (err instanceof BodyTooLargeError)
        {
            return ProblemMapper.StatusTooLarge
        }
        if (err instanceof HttpProblem)
        {
            return err.Status
        }
        const mapping = err instanceof Error ? this.MappingFor(err) : undefined
        return mapping === undefined || ProblemMapper.Masked(mapping) ? ProblemMapper.StatusInternal : mapping.Status
    }

    /** The registration of the error's own class, else of its nearest registered ancestor. */
    private MappingFor(err: Error): ProblemMapping | undefined
    {
        let prototype: object | null = Object.getPrototypeOf(err) as object | null
        while (prototype !== null && prototype !== Error.prototype)
        {
            const ctor = (prototype as { constructor: unknown }).constructor
            const found = this.mappings.find(mapping => mapping.ErrorClass === ctor)
            if (found !== undefined)
            {
                return found
            }
            prototype = Object.getPrototypeOf(prototype) as object | null
        }
        return undefined
    }

    private static Masked(mapping: ProblemMapping): boolean
    {
        return mapping.Status >= ProblemMapper.StatusInternal && mapping.Status !== ProblemMapper.StatusUnavailable && !mapping.Unmasked
    }
}
