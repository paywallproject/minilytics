/**
 * Networks (ASNs) of cloud and hosting providers. People browse from home, mobile and office ISPs, not from
 * these, so a "visitor" here is almost always a scraper or headless browser that runs JavaScript and hides
 * its user agent. Corporate VPNs and consumer VPN services are deliberately not listed.
 */
const HOSTING_ASNS = new Set([
  16509, 14618, 8987, // Amazon AWS
  396982, 15169, 19527, // Google Cloud
  8075, 8068, // Microsoft Azure
  31898, // Oracle Cloud
  14061, // DigitalOcean
  63949, // Linode / Akamai Cloud
  20473, // Vultr / Choopa
  24940, 213230, 212317, // Hetzner
  16276, // OVH
  12876, // Scaleway
  51167, // Contabo
  60781, 28753, 7203, // Leaseweb
  45102, 37963, 134963, // Alibaba Cloud
  132203, 45090, // Tencent Cloud
  136907, 55990, // Huawei Cloud
  135377, // UCloud
  21859, // Zenlayer
  62240, // Clouvider
  36352, // ColoCrossing
  396356, // Latitude.sh / Maxihost
]);

export function isHostingAsn(asn: unknown): boolean {
  return typeof asn === 'number' && HOSTING_ASNS.has(asn);
}
