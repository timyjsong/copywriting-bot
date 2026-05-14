import { promises as dns } from "node:dns";

/**
 * DNS verification for cold-email sending domains.
 *
 * MVP requires customer-owned dedicated sending domain with SPF, DKIM, and
 * DMARC records present. We only check existence + minimal sanity — full
 * deliverability tuning happens inside Smartlead.
 */

export type DnsCheckResult = {
  domain: string;
  spf: { found: boolean; record: string | null };
  dkim: { found: boolean; selector_checked: string };
  dmarc: { found: boolean; record: string | null };
  mx: { found: boolean; records: string[] };
  ready: boolean;
  issues: string[];
};

/** Default DKIM selector Smartlead instructs customers to add. */
const DEFAULT_DKIM_SELECTOR = "smartlead";

export async function verifySendingDomain(
  domain: string,
  dkimSelector: string = DEFAULT_DKIM_SELECTOR,
): Promise<DnsCheckResult> {
  const issues: string[] = [];

  const txtRecords = await safeTxt(domain);
  const spfRecord = txtRecords.find((r) => r.startsWith("v=spf1"));
  if (!spfRecord) issues.push(`No SPF record on ${domain}.`);

  const dkimHost = `${dkimSelector}._domainkey.${domain}`;
  const dkimRecords = await safeTxt(dkimHost);
  const dkimFound = dkimRecords.some((r) => r.includes("v=DKIM1"));
  if (!dkimFound) issues.push(`No DKIM record at ${dkimHost} (selector "${dkimSelector}").`);

  const dmarcRecords = await safeTxt(`_dmarc.${domain}`);
  const dmarcRecord = dmarcRecords.find((r) => r.startsWith("v=DMARC1"));
  if (!dmarcRecord) issues.push(`No DMARC record at _dmarc.${domain}.`);

  const mxRecords = await safeMx(domain);
  if (mxRecords.length === 0) issues.push(`No MX records on ${domain}.`);

  return {
    domain,
    spf: { found: !!spfRecord, record: spfRecord ?? null },
    dkim: { found: dkimFound, selector_checked: dkimSelector },
    dmarc: { found: !!dmarcRecord, record: dmarcRecord ?? null },
    mx: { found: mxRecords.length > 0, records: mxRecords },
    ready: issues.length === 0,
    issues,
  };
}

async function safeTxt(host: string): Promise<string[]> {
  try {
    const records = await dns.resolveTxt(host);
    return records.map((r) => r.join(""));
  } catch {
    return [];
  }
}

async function safeMx(host: string): Promise<string[]> {
  try {
    const records = await dns.resolveMx(host);
    return records.map((r) => `${r.priority} ${r.exchange}`);
  } catch {
    return [];
  }
}
