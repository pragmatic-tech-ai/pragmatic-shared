import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { HostAllowList } from '../host-allow-list.js'
import { OriginGuard } from '../origin-guard.js'
import { ClientAddress } from '../client-address.js'

class FakeRequest
{
    public static Of(headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9', encrypted = false): IncomingMessage
    {
        return { headers, socket: { remoteAddress, encrypted } } as unknown as IncomingMessage
    }
}

test('HostAllowList matches an allowed host, strips the port, lowercases, rejects others and malformed headers', () =>
{
    const hosts = new HostAllowList(['Admin.Example.com'])
    assert.equal(hosts.Allows(FakeRequest.Of({ host: 'admin.example.com' })), true)
    assert.equal(hosts.Allows(FakeRequest.Of({ host: 'ADMIN.example.com:8443' })), true)
    assert.equal(hosts.Allows(FakeRequest.Of({ host: 'evil.example' })), false)
    assert.equal(hosts.Allows(FakeRequest.Of({ host: 'evil.example:80' })), false)
    assert.equal(hosts.Allows(FakeRequest.Of({})), false)
    assert.equal(hosts.Allows(FakeRequest.Of({ host: 'a:b:c' })), false)
})

test('HostAllowList.WithLoopback admits localhost, 127.0.0.1 and [::1] besides the configured hosts', () =>
{
    const hosts = HostAllowList.WithLoopback(['console.example'])
    for (const host of ['localhost:3000', '127.0.0.1', '[::1]:9', 'console.example'])
    {
        assert.equal(hosts.Allows(FakeRequest.Of({ host })), true, host)
    }
    assert.equal(hosts.Allows(FakeRequest.Of({ host: 'other.example' })), false)
})

test('HostAllowList.Parse reads a comma-separated list, trimming and dropping empties', () =>
{
    const hosts = HostAllowList.Parse(' a.example , ,B.example ')
    assert.deepEqual([...hosts.Hosts].sort(), ['a.example', 'b.example'])
    assert.equal(HostAllowList.Parse(undefined).Hosts.size, 0)
})

test('HostName and HostPort parse a Host header; malformed is undefined', () =>
{
    assert.equal(HostAllowList.HostName('Example.COM:8080'), 'example.com')
    assert.equal(HostAllowList.HostPort('example.com:8080'), 8080)
    assert.equal(HostAllowList.HostPort('example.com'), undefined)
    assert.equal(HostAllowList.HostName('[::1]:5'), '[::1]')
    assert.equal(HostAllowList.HostName(undefined), undefined)
    assert.equal(HostAllowList.HostName('x:y:z'), undefined)
})

test('OriginGuard allows an absent Origin and the own origin (scheme and port included); refuses a foreign one', () =>
{
    const guard = new OriginGuard(false)
    assert.equal(guard.Allows(FakeRequest.Of({ host: 'localhost:8080' })), true)
    assert.equal(guard.Allows(FakeRequest.Of({ host: 'localhost:8080', origin: 'http://localhost:8080' })), true)
    assert.equal(guard.Allows(FakeRequest.Of({ host: 'localhost:8080', origin: 'http://localhost:9090' })), false)
    assert.equal(guard.Allows(FakeRequest.Of({ host: 'localhost:8080', origin: 'http://evil.example' })), false)
    assert.equal(guard.Allows(FakeRequest.Of({ host: 'localhost:8080', origin: 'null' })), false)
})

test('OriginGuard: without a proxy an https Origin is a scheme mismatch; a TLS socket is https', () =>
{
    const guard = new OriginGuard(false)
    assert.equal(guard.Allows(FakeRequest.Of({ host: 'admin.example', origin: 'https://admin.example' })), false)
    assert.equal(guard.Allows(FakeRequest.Of({ host: 'admin.example', origin: 'https://admin.example' }, '1.1.1.1', true)), true)
})

test('OriginGuard honours x-forwarded-proto https only behind a trusted proxy (its last hop)', () =>
{
    const proxied = new OriginGuard(true)
    assert.equal(proxied.Allows(FakeRequest.Of({ host: 'admin.example', origin: 'https://admin.example', 'x-forwarded-proto': 'https' })), true)
    assert.equal(proxied.Allows(FakeRequest.Of({ host: 'admin.example', origin: 'https://admin.example', 'x-forwarded-proto': 'https, http' })), false)
    assert.equal(proxied.Allows(FakeRequest.Of({ host: 'admin.example', origin: 'https://evil.example', 'x-forwarded-proto': 'https' })), false)
    const direct = new OriginGuard(false)
    assert.equal(direct.Allows(FakeRequest.Of({ host: 'admin.example', origin: 'https://admin.example', 'x-forwarded-proto': 'https' })), false)
})

test('ClientAddress is the socket peer; a forged x-forwarded-for is ignored without a trusted proxy', () =>
{
    assert.equal(new ClientAddress(false).Of(FakeRequest.Of({ 'x-forwarded-for': '6.6.6.6' }, '10.1.1.1')), '10.1.1.1')
})

test('ClientAddress behind a trusted proxy is the last x-forwarded-for hop, only when it is an IP address', () =>
{
    const proxied = new ClientAddress(true)
    assert.equal(proxied.Of(FakeRequest.Of({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, '10.1.1.1')), '203.0.113.7')
    assert.equal(proxied.Of(FakeRequest.Of({ 'x-forwarded-for': ['1.1.1.1', '2001:db8::1'] }, '10.1.1.1')), '2001:db8::1')
    assert.equal(proxied.Of(FakeRequest.Of({ 'x-forwarded-for': '1.1.1.1, not-an-ip' }, '10.1.1.1')), '10.1.1.1')
    assert.equal(proxied.Of(FakeRequest.Of({}, '10.1.1.1')), '10.1.1.1')
})
