import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RealmIssuer } from '../realm-issuer.js'

class IssuerFixture
{
    public static readonly Base = 'https://login.example.test//'
    public static readonly Realm = 'central realm'
    public static readonly Issuer = 'https://login.example.test/realms/central%20realm'
}

describe('RealmIssuer', () =>
{
    it('builds the issuer, discovery and broker callback URLs from a base without its trailing slashes', () =>
    {
        assert.equal(RealmIssuer.Of(IssuerFixture.Base, IssuerFixture.Realm), IssuerFixture.Issuer)
        assert.equal(RealmIssuer.DiscoveryOf(IssuerFixture.Base, IssuerFixture.Realm), IssuerFixture.Issuer + RealmIssuer.DiscoveryPath)
        assert.equal(RealmIssuer.BrokerCallbackOf(IssuerFixture.Issuer, 'google'), IssuerFixture.Issuer + '/broker/google/callback')
    })

    it('patterns a route under the realm', () =>
    {
        assert.equal(RealmIssuer.Pattern(RealmIssuer.TokenPath), '/realms/:realm/protocol/openid-connect/token')
    })
})
