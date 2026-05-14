import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveTxtMock, resolveMxMock } = vi.hoisted(() => ({
  resolveTxtMock: vi.fn(),
  resolveMxMock: vi.fn(),
}));

vi.mock("node:dns", () => ({
  promises: {
    resolveTxt: resolveTxtMock,
    resolveMx: resolveMxMock,
  },
}));

import { verifySendingDomain } from "./dns.js";

beforeEach(() => {
  resolveTxtMock.mockReset();
  resolveMxMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * `node:dns`.promises.resolveTxt returns string[][] (each TXT record can be
 * split across multiple strings). The helper joins them with "". We mirror
 * that shape in test fixtures.
 */
function txt(records: string[]): string[][] {
  return records.map((r) => [r]);
}

describe("verifySendingDomain", () => {
  it("returns ready=true when SPF, DKIM, DMARC, MX are all present", async () => {
    resolveTxtMock.mockImplementation(async (host: string) => {
      if (host === "outbound.acme.example") {
        return txt(["v=spf1 include:_spf.smartlead.ai ~all"]);
      }
      if (host === "smartlead._domainkey.outbound.acme.example") {
        return txt(["v=DKIM1; k=rsa; p=AAAA"]);
      }
      if (host === "_dmarc.outbound.acme.example") {
        return txt(["v=DMARC1; p=quarantine; rua=mailto:rua@acme.example"]);
      }
      return [];
    });
    resolveMxMock.mockResolvedValueOnce([{ priority: 10, exchange: "mx.smartlead.ai" }]);

    const out = await verifySendingDomain("outbound.acme.example");
    expect(out.ready).toBe(true);
    expect(out.issues).toEqual([]);
    expect(out.spf.found).toBe(true);
    expect(out.spf.record).toMatch(/v=spf1/);
    expect(out.dkim.found).toBe(true);
    expect(out.dkim.selector_checked).toBe("smartlead");
    expect(out.dmarc.found).toBe(true);
    expect(out.mx.found).toBe(true);
    expect(out.mx.records).toEqual(["10 mx.smartlead.ai"]);
  });

  it("flags missing SPF / DKIM / DMARC / MX records", async () => {
    resolveTxtMock.mockResolvedValue([]);
    resolveMxMock.mockResolvedValue([]);

    const out = await verifySendingDomain("bare.example");
    expect(out.ready).toBe(false);
    expect(out.issues).toContain("No SPF record on bare.example.");
    expect(out.issues).toContain('No DKIM record at smartlead._domainkey.bare.example (selector "smartlead").');
    expect(out.issues).toContain("No DMARC record at _dmarc.bare.example.");
    expect(out.issues).toContain("No MX records on bare.example.");
  });

  it("treats DNS lookup errors as 'not found' (does not throw)", async () => {
    resolveTxtMock.mockRejectedValue(new Error("ENOTFOUND"));
    resolveMxMock.mockRejectedValue(new Error("ENOTFOUND"));

    const out = await verifySendingDomain("nx.example");
    expect(out.ready).toBe(false);
    expect(out.spf.found).toBe(false);
    expect(out.dkim.found).toBe(false);
    expect(out.dmarc.found).toBe(false);
    expect(out.mx.found).toBe(false);
  });

  it("respects a custom DKIM selector", async () => {
    const queriedHosts: string[] = [];
    resolveTxtMock.mockImplementation(async (host: string) => {
      queriedHosts.push(host);
      if (host === "k1._domainkey.foo.example") return txt(["v=DKIM1; p=xxx"]);
      return [];
    });
    resolveMxMock.mockResolvedValueOnce([]);

    const out = await verifySendingDomain("foo.example", "k1");
    expect(out.dkim.found).toBe(true);
    expect(out.dkim.selector_checked).toBe("k1");
    expect(queriedHosts).toContain("k1._domainkey.foo.example");
    expect(queriedHosts).not.toContain("smartlead._domainkey.foo.example");
  });

  it("requires v=DKIM1 marker in the record (a random TXT does not count)", async () => {
    resolveTxtMock.mockImplementation(async (host: string) => {
      if (host === "smartlead._domainkey.foo.example") {
        return txt(["unrelated text only"]);
      }
      return [];
    });
    resolveMxMock.mockResolvedValueOnce([]);

    const out = await verifySendingDomain("foo.example");
    expect(out.dkim.found).toBe(false);
  });

  it("joins multi-segment TXT records when matching SPF/DMARC", async () => {
    resolveTxtMock.mockImplementation(async (host: string) => {
      if (host === "split.example") {
        return [["v=spf1 ", "include:_spf.smartlead.ai ~all"]];
      }
      if (host === "_dmarc.split.example") {
        return [["v=DMARC1; ", "p=none"]];
      }
      return [];
    });
    resolveMxMock.mockResolvedValueOnce([{ priority: 5, exchange: "mx.example" }]);

    const out = await verifySendingDomain("split.example");
    expect(out.spf.found).toBe(true);
    expect(out.spf.record).toBe("v=spf1 include:_spf.smartlead.ai ~all");
    expect(out.dmarc.found).toBe(true);
    expect(out.dmarc.record).toBe("v=DMARC1; p=none");
  });
});
