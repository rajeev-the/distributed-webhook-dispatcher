import { URL } from 'url';
import net from 'net';
import dns from 'dns/promises';
import { config } from '../config.js';

/**
 * Checks if an IP is within private/internal/reserved ranges
 */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 (Private)
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (Private)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (Link-local / AWS metadata)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0
    if (parts[0] === 0) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // ::1 (Loopback)
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    // fc00::/7 (Unique local)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // fe80::/10 (Link-local)
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || 
        normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    return false;
  }

  return false;
}

/**
 * Validates destination URL for SSRF vulnerabilities
 */
export async function validateDestinationUrl(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch (err) {
    throw new Error('Invalid URL format');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol}. Only http: and https: are allowed.`);
  }

  const hostname = parsedUrl.hostname;

  // In development or when explicitly allowed (for local testing and mock receiver)
  if (config.allowInternalTargets) {
    return {
      valid: true,
      url: parsedUrl.toString(),
      host: hostname
    };
  }

  // Reject explicit localhost names
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`Destination hostname '${hostname}' is rejected for security (internal target).`);
  }

  // Check if hostname is directly an IP
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Destination IP '${hostname}' is rejected for security (private network).`);
    }
    return { valid: true, url: parsedUrl.toString(), host: hostname };
  }

  // Resolve hostname via DNS to prevent DNS rebinding to private IPs
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        throw new Error(`Hostname '${hostname}' resolves to private IP '${addr.address}'. Blocked for security.`);
      }
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND') {
      throw new Error(`Cannot resolve hostname '${hostname}'.`);
    }
    throw err;
  }

  return {
    valid: true,
    url: parsedUrl.toString(),
    host: hostname
  };
}
