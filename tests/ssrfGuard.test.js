import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, validateDestinationUrl } from '../src/services/ssrfGuard.js';

describe('SSRF Protection Guard', () => {
  test('correctly identifies private IPv4 addresses', () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('10.0.0.5'), true);
    assert.equal(isPrivateIp('172.16.0.1'), true);
    assert.equal(isPrivateIp('192.168.1.100'), true);
    assert.equal(isPrivateIp('169.254.169.254'), true);
    assert.equal(isPrivateIp('8.8.8.8'), false);
    assert.equal(isPrivateIp('1.1.1.1'), false);
  });

  test('correctly identifies loopback and private IPv6', () => {
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('fe80::1'), true);
    assert.equal(isPrivateIp('fc00::1'), true);
  });

  test('rejects non-http/https protocols', async () => {
    await assert.rejects(
      () => validateDestinationUrl('ftp://ftp.example.com/webhook'),
      /Unsupported protocol/
    );
    await assert.rejects(
      () => validateDestinationUrl('file:///etc/passwd'),
      /Unsupported protocol/
    );
  });
});
