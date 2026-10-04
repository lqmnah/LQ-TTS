import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebhookUrlError, isPublicAddress, resolveWebhookUrl, signWebhook } from '../services/webhook-security.js';

const answers = (...addresses) => vi.fn(async () => addresses.map((address) => ({ address, family: net.isIP(address) })));

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '100.127.255.255', '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1', '198.18.0.1', '192.0.2.10',
    '::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2001::1', '2002:a00:1::1', 'not-an-ip', '',
    // Beyond the plan: other spellings and embeddings of private IPv4, and the rest of the special IPv6 space.
    '0.1.2.3', '169.254.0.1', '198.51.100.7', '203.0.113.9', '192.0.0.8',
    '0:0:0:0:0:ffff:a00:1', '::FFFF:A9FE:A9FE', '::ffff:169.254.169.254', '::ffff:0:a00:1', '::ffff:0:7f00:1', '::a00:1',
    '::127.0.0.1', '64:ff9b::8.8.8.8', '64:ff9b:1::a00:1', '2002:7f00:1::', '100::1', 'fe80::1%eth0', 'febf::1',
    'fdff:ffff::1', 'ff05::1:3', '2001:2::1', '3fff::1', '5f00::1', '1.2.3', '127.1', '::ffff:1.2.3', '1::2::3',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8',
    '::ffff:808:808', '2a00:1450:4001:82a::200e', '2001:4860:4860::8888',
  ])('accepts %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('resolveWebhookUrl', () => {
  it('accepts https on 443 to a host that resolves only to public addresses, and pins the first one', async () => {
    const lookup = answers('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    await expect(resolveWebhookUrl('https://hooks.example.com/lqtts?x=1', { lookup })).resolves.toEqual({
      url: 'https://hooks.example.com/lqtts?x=1', address: '93.184.216.34', family: 4,
    });
    expect(lookup).toHaveBeenCalledWith('hooks.example.com');
    await expect(resolveWebhookUrl('https://hooks.example.com:443/x', { lookup })).resolves.toMatchObject({ url: 'https://hooks.example.com/x' });
  });

  it.each([
    ['http://hooks.example.com/x', /must use https/],
    ['https://hooks.example.com:8443/x', /port 443/],
    ['https://user:pw@hooks.example.com/x', /user name or password/],
    [`https://hooks.example.com/${'a'.repeat(480)}`, /at most 500/],
    ['ftp://hooks.example.com/x', /must use https/],
    ['not a url', /not a valid URL/],
    [42, /at most 500/],
  ])('refuses %s before any DNS lookup', async (raw, message) => {
    const lookup = answers('93.184.216.34');
    await expect(resolveWebhookUrl(raw, { lookup })).rejects.toThrow(message);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['https://10.0.0.1/x', []],
    ['https://[::1]/x', []],
    ['https://169.254.169.254/latest/meta-data', []],
    ['https://inside.example.com/x', ['10.0.0.7']],
    ['https://mixed.example.com/x', ['93.184.216.34', '192.168.1.5']],
    ['https://rebind.example.com/x', ['::ffff:127.0.0.1']],
    // WHATWG URL normalises these hosts to 127.0.0.1 and ::ffff:a9fe:a9fe; they must not slip past as names.
    ['https://0x7f.1/x', []],
    ['https://2130706433/x', []],
    ['https://[::ffff:169.254.169.254]/x', []],
    ['https://nat64.example.com/x', ['64:ff9b::a9fe:a9fe']],
  ])('refuses %s, which reaches a non-public address', async (raw, resolved) => {
    const lookup = answers(...resolved);
    await expect(resolveWebhookUrl(raw, { lookup })).rejects.toThrow(/public address/);
    if (!resolved.length) expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a host that does not resolve', async () => {
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const err = await resolveWebhookUrl('https://nowhere.example.com/x', { lookup }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookUrlError);
    expect(err.message).toMatch(/does not resolve/);
    await expect(resolveWebhookUrl('https://empty.example.com/x', { lookup: answers() })).rejects.toThrow(/does not resolve/);
  });

  it('lets local runs reach a loopback receiver over http on any port, and nothing else private', async () => {
    await expect(resolveWebhookUrl('http://127.0.0.1:9999/hook', { allowLoopback: true })).resolves.toEqual({
      url: 'http://127.0.0.1:9999/hook', address: '127.0.0.1', family: 4,
    });
    await expect(resolveWebhookUrl('http://localhost:9999/hook', { allowLoopback: true, lookup: answers('127.0.0.1', '::1') }))
      .resolves.toMatchObject({ address: '127.0.0.1' });
    await expect(resolveWebhookUrl('http://10.0.0.1:9999/hook', { allowLoopback: true })).rejects.toThrow(/must use https/);
    await expect(resolveWebhookUrl('https://192.168.1.5/hook', { allowLoopback: true })).rejects.toThrow(/public address/);
    await expect(resolveWebhookUrl('http://mixed.example.com:9999/hook', { allowLoopback: true, lookup: answers('127.0.0.1', '10.0.0.1') }))
      .rejects.toThrow(/must use https/);
    await expect(resolveWebhookUrl('http://127.0.0.1:9999/hook')).rejects.toThrow(/must use https/);
    await expect(resolveWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(/public address/);
  });
});

describe('signWebhook', () => {
  it('signs "<t>.<body>" with HMAC-SHA256 under the webhook secret', () => {
    expect(signWebhook('whsec_test', '{"event":"job.done"}', 1700000000))
      .toBe('t=1700000000,v1=f86a58b1a8a35080339acb9adaaf07138b28ac2cb787c4437a5ff327c61d0ef1');
    expect(signWebhook('whsec_test', '{"event":"job.done"}')).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
  });
});
