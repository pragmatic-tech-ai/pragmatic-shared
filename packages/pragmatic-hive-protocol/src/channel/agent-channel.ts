import type { SignedEnvelope } from '../envelope/signed-envelope.js'

/**
 * The agent's side of the agent channel: send one signed message, get the platform's signed reply (an enrolment
 * response, a pull batch) or null when the platform only acknowledges (a report, a decision). The transport (HTTPS
 * through the edge today) is the implementation's; every message is verified end to end whatever carries it.
 */
export interface IAgentChannel
{
    Exchange(request: SignedEnvelope): Promise<SignedEnvelope | null>
}
