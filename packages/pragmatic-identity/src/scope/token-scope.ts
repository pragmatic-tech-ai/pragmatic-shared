import { AccessContext } from '../authz/access-context.js'

/** Scopes a service token may carry that restrict which methods it can call. */
export enum TokenScope
{
    GraphContribute = 'graph-contribute',
    ApplicationDeploy = 'application-deploy',
    Inspect = 'environment-inspect',
    Develop = 'environment-develop',
    RunTest = 'environment-run-test',
}

/** An AccessContext built from a service-token authentication, carrying that token's scopes explicitly.
 *  Session-authenticated contexts are never wrapped, so a session principal's groups are never read as scopes.
 *  WARNING: the handler detects scopes by instanceof; rebuilding or cloning the AccessContext on its way to
 *  ServerConnectionHandler.Attach drops them and FAILS OPEN. Pass this instance through unchanged. */
export class ScopedAccessContext extends AccessContext
{
    public readonly Scopes: readonly string[]

    public constructor(base: AccessContext, scopes: readonly string[])
    {
        super(base.Principal, base.Realm, base.Grants, base.Policy)
        this.Scopes = scopes
    }
}

/**
 * The environment server's request methods a scope can name, as the wire carries them (pragmatic-protocol's
 * `<Protocol>.<Request>.method`). Held here, not imported, so the identity contracts take no protocol dependency; the
 * environment server's test pins every value to the protocol's.
 */
export class ScopedMethods
{
    public static readonly SolutionList = 'solution/list'
    public static readonly SolutionSelectAuthoring = 'solution/selectAuthoring'
    public static readonly SolutionCreate = 'solution/create'
    public static readonly SolutionActive = 'solution/active'
    public static readonly StorageReadText = 'storage/readText'
    public static readonly StorageReadBytes = 'storage/readBytes'
    public static readonly StorageWriteText = 'storage/writeText'
    public static readonly StorageWriteBytes = 'storage/writeBytes'
    public static readonly StorageExists = 'storage/exists'
    public static readonly StorageDelete = 'storage/delete'
    public static readonly StorageCreateDirectory = 'storage/createDirectory'
    public static readonly StorageRename = 'storage/rename'
    public static readonly StorageList = 'storage/list'
    public static readonly LanguageCompletions = 'language/completions'
    public static readonly LanguageHover = 'language/hover'
    public static readonly LanguageDefinition = 'language/definition'
    public static readonly LanguageReferences = 'language/references'
    public static readonly LanguagePrepareRename = 'language/prepareRename'
    public static readonly LanguageRename = 'language/rename'
    public static readonly LanguageDocumentSymbols = 'language/documentSymbols'
    public static readonly LanguageFoldingRanges = 'language/foldingRanges'
    public static readonly LanguageWorkspaceSymbols = 'language/workspaceSymbols'
    public static readonly LanguageSemanticTokens = 'language/semanticTokens'
    public static readonly LanguageSignatureHelp = 'language/signatureHelp'
    public static readonly LanguageCodeActions = 'language/codeActions'
    public static readonly LanguageFormat = 'language/format'
    public static readonly LanguageDiagnostics = 'language/diagnostics'
    public static readonly GraphList = 'graph/list'
    public static readonly GraphContribute = 'graph/contribute'
    public static readonly GraphLoaded = 'graph/loaded'
    public static readonly RunTestLoad = 'runtime/run-test'
    public static readonly ApplicationList = 'application/list'
    public static readonly ApplicationDeploy = 'application/deploy'
}

/**
 * The request methods a develop credential may call: list and select solutions, read and write source, drive the language
 * service, and list and contribute graphs. Deliberately excludes graph create/delete/load, application/*, data/*, solution/open
 * (administer-gated) and admin/*. Shared with the desktop relay's develop allowlist so the two cannot drift.
 */
export class DevelopMethods
{
    public static readonly All: readonly string[] = [
        ScopedMethods.SolutionList,
        ScopedMethods.SolutionSelectAuthoring,
        ScopedMethods.SolutionCreate,
        ScopedMethods.SolutionActive,
        ScopedMethods.StorageReadText,
        ScopedMethods.StorageReadBytes,
        ScopedMethods.StorageWriteText,
        ScopedMethods.StorageWriteBytes,
        ScopedMethods.StorageExists,
        ScopedMethods.StorageDelete,
        ScopedMethods.StorageCreateDirectory,
        ScopedMethods.StorageRename,
        ScopedMethods.StorageList,
        ScopedMethods.LanguageCompletions,
        ScopedMethods.LanguageHover,
        ScopedMethods.LanguageDefinition,
        ScopedMethods.LanguageReferences,
        ScopedMethods.LanguagePrepareRename,
        ScopedMethods.LanguageRename,
        ScopedMethods.LanguageDocumentSymbols,
        ScopedMethods.LanguageFoldingRanges,
        ScopedMethods.LanguageWorkspaceSymbols,
        ScopedMethods.LanguageSemanticTokens,
        ScopedMethods.LanguageSignatureHelp,
        ScopedMethods.LanguageCodeActions,
        ScopedMethods.LanguageFormat,
        ScopedMethods.LanguageDiagnostics,
        ScopedMethods.GraphList,
        ScopedMethods.GraphContribute,
    ]
}

/**
 * The request methods a run/test credential may call: load a build into the run/test runtime, list the loaded applications,
 * and read the loaded graph. Strictly narrower than application/deploy (administer-gated) and the develop allowlist: no data,
 * shares, assignment, application/open or graph create/delete. Shared with the desktop relay's run/test allowlist so the two
 * cannot drift.
 */
export class RunTestMethods
{
    public static readonly All: readonly string[] = [
        ScopedMethods.RunTestLoad,
        ScopedMethods.ApplicationList,
        ScopedMethods.GraphLoaded,
    ]
}

/** Restricts the methods a credential may call by its known scopes. With no known scope the gate allows everything. */
export class TokenScopeGate
{
    private static readonly MethodsByScope: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
        [TokenScope.GraphContribute, [ScopedMethods.GraphContribute, ScopedMethods.GraphList]],
        [TokenScope.ApplicationDeploy, [ScopedMethods.ApplicationDeploy]],
        [TokenScope.Inspect, [ScopedMethods.ApplicationList, ScopedMethods.GraphList, ScopedMethods.GraphLoaded]],
        [TokenScope.Develop, DevelopMethods.All],
        [TokenScope.RunTest, RunTestMethods.All],
    ])

    private readonly allowed: ReadonlySet<string> | null

    private constructor(allowed: ReadonlySet<string> | null)
    {
        this.allowed = allowed
    }

    public static For(scopes: readonly string[]): TokenScopeGate
    {
        const allowed = new Set<string>()
        let known = false
        for (const scope of scopes)
        {
            const methods = TokenScopeGate.MethodsByScope.get(scope)
            if (methods !== undefined)
            {
                known = true
                methods.forEach(method => allowed.add(method))
            }
        }
        return new TokenScopeGate(known ? allowed : null)
    }

    /** The gate for a connection's context: scoped only when it came from a service token. */
    public static ForContext(context: AccessContext): TokenScopeGate
    {
        return TokenScopeGate.For(context instanceof ScopedAccessContext ? context.Scopes : [])
    }

    public Allows(method: string): boolean
    {
        return this.allowed === null || this.allowed.has(method)
    }
}
