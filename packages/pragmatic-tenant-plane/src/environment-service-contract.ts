import type { EnvType, Template, EnvironmentChange, EnvironmentRecord } from './environment-record.js'
import type { AdminSnapshot } from './admin-proxy.js'
import type { CreateAccountParams, GraphLoadedDto, GrantMutationDto, IdentityConfigDto, SecurityCatalogDto, SecurityChangesDto, SecurityModelDto, TeamMemberDto, TokenIssuedDto, ServiceTokenSummaryDto, IssueTokenParams } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { ILogProcess } from './seed/log-process.js'

/** What the tenant plane asks of the platform console's environment and graph services (the console implements them). */
export interface IEnvironmentService
{
    Create(name: string, template: Template, type: EnvType, hostPort?: number, hiveId?: string, creatorPrincipalId?: string): Promise<EnvironmentRecord>
    Start(name: string): Promise<EnvironmentRecord>
    Stop(name: string): Promise<EnvironmentRecord>
    Restart(name: string): Promise<EnvironmentRecord>
    Delete(name: string): Promise<void>
    List(): readonly EnvironmentRecord[]
    ListReconciled(): Promise<readonly EnvironmentRecord[]>
    Logs(name: string): Promise<string>
    LogStream(name: string, onData: (chunk: string) => void): ILogProcess
    /** Additive lifecycle-change subscription (RULING 5): fires on create, every status change, and delete; returns an unsubscribe. */
    OnChanged(cb: (change: EnvironmentChange) => void): () => void
    AdminSnapshot(name: string): Promise<AdminSnapshot>
    AdminCreateAccount(name: string, params: CreateAccountParams): Promise<void>
    AdminDisableAccount(name: string, principalId: string): Promise<void>
    AdminGrantRole(name: string, mutation: GrantMutationDto): Promise<void>
    AdminRevokeRole(name: string, mutation: GrantMutationDto): Promise<void>
    AdminGetConfig(name: string): Promise<IdentityConfigDto>
    AdminSetConfig(name: string, config: IdentityConfigDto): Promise<void>
    AdminGetSecurityModel(name: string): Promise<SecurityModelDto | undefined>
    AdminSetSecurityModel(name: string, securityModel: SecurityModelDto): Promise<void>
    AdminGetSecurityCatalog(name: string): Promise<SecurityCatalogDto>
    AdminListTeamMembers(name: string, teamId: string): Promise<TeamMemberDto[]>
    AdminListSecurityChanges(name: string): Promise<SecurityChangesDto[]>
    AdminIssueMakerToken(name: string): Promise<TokenIssuedDto>
    AdminIssueDeployToken(name: string): Promise<TokenIssuedDto>
    AdminIssueDeveloperToken(name: string): Promise<TokenIssuedDto>
    AdminIssueRunTestToken(name: string): Promise<TokenIssuedDto>
    AdminIssueReaderToken(name: string): Promise<TokenIssuedDto>
    AdminListTokens(name: string): Promise<ServiceTokenSummaryDto[]>
    AdminIssueToken(name: string, params: IssueTokenParams): Promise<TokenIssuedDto>
    AdminRevokeToken(name: string, tokenRef: string): Promise<void>
    AdminGrantAppReader(name: string): Promise<void>
}

export interface IGraphService
{
    Create(envName: string, name: string, description: string): Promise<GraphDto>
    List(envName: string): Promise<readonly GraphDto[]>
    Get(envName: string, graphName: string): Promise<GraphDto>
    Delete(envName: string, graphName: string): Promise<void>
    Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>
    GetLoaded(runtimeEnv: string): Promise<GraphLoadedDto | null>
}

/** The only fields of an issued maker token revealed to the operator. */
export interface MakerTokenDto
{
    token: string
    principalId: string
    expiresAt: string | null
}

export type GraphDto = {
    name: string
    description: string
    packageCount: number
    createdAt: string
}

/** The result of promoting a dev graph into a runtime environment: non-secret refs only. */
export type PromotionResultDto = {
    graphName: string
    packageCount: number
    targetEnv: string
}
