import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PendingSecret, type IHoldsPendingSecret } from '../holds-pending-secret.js'
import { PendingWork, type IHoldsPendingWork } from '../holds-pending-work.js'

class SecretHolder implements IHoldsPendingSecret
{
    public HasPendingSecret = true

    public constructor()
    {
        PendingSecret.Register(this)
    }
}

class WorkHolder implements IHoldsPendingWork
{
    public HasPendingWork = false

    public constructor()
    {
        PendingWork.Register(this)
    }
}

describe('PendingSecret', () =>
{
    it('recognises a registered page by identity, never by a member that happens to match', () =>
    {
        const holder = new SecretHolder()
        const lookalike = { HasPendingSecret: true }
        assert.equal(PendingSecret.IsHolder(holder), true)
        assert.equal(PendingSecret.IsHolder(lookalike), false)
        assert.equal(PendingSecret.IsHolder(undefined), false)
        assert.equal(PendingSecret.IsHeldBy(lookalike), false)
    })

    it('holds only while the page still has its value', () =>
    {
        const holder = new SecretHolder()
        assert.equal(PendingSecret.IsHeldBy(holder), true)
        holder.HasPendingSecret = false
        assert.equal(PendingSecret.IsHeldBy(holder), false)
        assert.equal(PendingSecret.ChangedProperty, 'HasPendingSecret')
    })
})

describe('PendingWork', () =>
{
    it('recognises a registered page by identity and holds only while work is pending', () =>
    {
        const holder = new WorkHolder()
        assert.equal(PendingWork.IsHolder(holder), true)
        assert.equal(PendingWork.IsHolder({ HasPendingWork: true }), false)
        assert.equal(PendingWork.IsHeldBy(holder), false)
        holder.HasPendingWork = true
        assert.equal(PendingWork.IsHeldBy(holder), true)
        assert.equal(PendingWork.IsHeldBy(undefined), false)
        assert.equal(PendingWork.ChangedProperty, 'HasPendingWork')
    })
})
