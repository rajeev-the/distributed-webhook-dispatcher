import dns from 'dns';
import dnsPromises from 'dns/promises';

/**
 * Fallback DNS resolver for environments where local ISP DNS servers
 * block or refuse cloud hostnames (such as *.neon.tech or *.aws.neon.tech).
 * 
 * If system getaddrinfo returns ENOTFOUND or EREFUSED, it falls back
 * to standard public DNS (Google 8.8.8.8, Cloudflare 1.1.1.1, Quad9 9.9.9.9).
 */
const originalLookup = dns.lookup;
const resolver = new dnsPromises.Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1', '9.9.9.9']);

dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  originalLookup(hostname, options, (err, address, family) => {
    if (err && (err.code === 'ENOTFOUND' || err.code === 'EREFUSED')) {
      resolver.resolve4(hostname)
        .then((ips) => {
          if (options && options.all) {
            callback(null, ips.map(ip => ({ address: ip, family: 4 })));
          } else {
            callback(null, ips[0], 4);
          }
        })
        .catch(() => {
          callback(err, address, family);
        });
    } else {
      callback(err, address, family);
    }
  });
};
