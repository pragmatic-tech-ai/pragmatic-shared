import type { SigningPublicKey } from '../crypto/signing-key.js'
import { EnvelopeVerifier, KeyDirectory, type VerifiedMessage } from '../envelope/envelope-verifier.js'
import { MessageKind } from '../envelope/message-kind.js'
import type { INonceLedger } from '../envelope/nonce-ledger.js'
import { Participant } from '../envelope/participant.js'
import type { IProtocolClock } from '../envelope/protocol-clock.js'
import { ProtocolVerificationError, VerificationFailure } from '../envelope/protocol-verification-error.js'
import { SignedEnvelope, type IBodyDecoder } from '../envelope/signed-envelope.js'
import { ProtocolDecodeError } from '../wire/protocol-decode-error.js'
import { HiveEnrolmentRequest, HiveEnrolmentResponse } from '../hive/hive-enrolment.js'
import { HostEnrolmentRequest, HostEnrolmentResponse } from '../host/host-enrolment.js'

/** A response that is well signed but does not answer the request that was sent. */
export class EnrolmentMismatchError extends Error
{
    private static readonly ErrorName = 'EnrolmentMismatchError'

    public constructor(public readonly Reason: EnrolmentMismatch)
    {
        super(Reason)
        this.name = EnrolmentMismatchError.ErrorName
    }
}

export enum EnrolmentMismatch
{
    NotThisRequest = 'The enrolment response answers another request.',
    OtherTenantOrLevel = 'The enrolment response records another tenant or level than was asked.',
    UntrustedRoot = 'The enrolment response carries another trust root than the one this agent was installed with.',
}

export interface EnrolmentHandshakeOptions
{
    Clock: IProtocolClock
    Nonces: INonceLedger
    /** The trust root the agent was installed with, when it was (a published key): the response must carry it. */
    PinnedTrustRoot?: SigningPublicKey
}

/**
 * The agent side of enrolment. The response is how the agent learns the platform's trust root, so it is accepted on
 * the strength of the TLS connection to the edge and the one-time code, plus: it is signed by the trust root it
 * carries, addressed to the agent's key id, fresh, answers the exact request (its nonce) and records the tenant and
 * level asked; when the agent was installed with a pinned trust root, it must be that one. From then on the agent
 * verifies every platform message against the adopted trust root.
 */
export class EnrolmentHandshake
{
    public constructor(private readonly options: EnrolmentHandshakeOptions)
    {
    }

    public async AcceptHive(response: SignedEnvelope, request: SignedEnvelope): Promise<VerifiedMessage<HiveEnrolmentResponse>>
    {
        const asked = HiveEnrolmentRequest.Parse(request.Body)
        const verified = await this.Accept(response, request, MessageKind.HiveEnrolmentResponse, HiveEnrolmentResponse, HiveEnrolmentResponse.KeyOf)
        if (verified.Body.Tenant !== asked.Tenant || verified.Body.Level !== asked.Level)
        {
            throw new EnrolmentMismatchError(EnrolmentMismatch.OtherTenantOrLevel)
        }
        return verified
    }

    public async AcceptHost(response: SignedEnvelope, request: SignedEnvelope): Promise<VerifiedMessage<HostEnrolmentResponse>>
    {
        HostEnrolmentRequest.Parse(request.Body)
        return this.Accept(response, request, MessageKind.HostEnrolmentResponse, HostEnrolmentResponse, HostEnrolmentResponse.KeyOf)
    }

    private async Accept<T extends { RequestNonce: string }>(response: SignedEnvelope, request: SignedEnvelope, kind: MessageKind, decoder: IBodyDecoder<T>, keyOf: (body: T) => SigningPublicKey): Promise<VerifiedMessage<T>>
    {
        let body: T
        try
        {
            body = decoder.Parse(response.Body, SignedEnvelope.BodyPath)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                throw new ProtocolVerificationError(VerificationFailure.Malformed, error)
            }
            throw error
        }
        const root = keyOf(body)
        const pinned = this.options.PinnedTrustRoot
        if (pinned !== undefined && !pinned.Equals(root))
        {
            throw new EnrolmentMismatchError(EnrolmentMismatch.UntrustedRoot)
        }
        const verifier = new EnvelopeVerifier({ Self: request.Issuer, Keys: new KeyDirectory().Add(Participant.Platform, root), Nonces: this.options.Nonces, Clock: this.options.Clock })
        const verified = await verifier.Verify(response, kind, decoder)
        if (verified.Body.RequestNonce !== request.Nonce)
        {
            throw new EnrolmentMismatchError(EnrolmentMismatch.NotThisRequest)
        }
        return verified
    }
}
