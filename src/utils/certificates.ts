/** Lightweight X.509 / PEM helpers for Kubernetes TLS secrets. */

export type CertTone = "ok" | "warn" | "err" | "idle";

export type CertificateInfo = {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  dnsNames: string[];
  ipAddresses: string[];
  emails: string[];
  uris: string[];
  fingerprintSha256: string;
  publicKeyAlgorithm: string;
  isCA: boolean;
  keyUsage: string[];
};

export type ParsedPemBlock = {
  label: string;
  type: string;
  der: Uint8Array;
};

export type SecretCertEntry = {
  key: string;
  certificates: CertificateInfo[];
  parseError?: string;
};

export type SecretKeySummary = {
  key: string;
  kind: "certificate" | "private-key" | "other";
  detail: string;
};

const ATTR_OID: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.4": "SN",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.9": "street",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.12": "title",
  "1.2.840.113549.1.9.1": "emailAddress",
  "0.9.2342.19200300.100.1.25": "DC",
  "0.9.2342.19200300.100.1.1": "UID",
};

const EXT_SAN = "2.5.29.17";
const EXT_KEY_USAGE = "2.5.29.15";
const EXT_BASIC_CONSTRAINTS = "2.5.29.19";

const KEY_USAGE_BITS = [
  "digitalSignature",
  "nonRepudiation",
  "keyEncipherment",
  "dataEncipherment",
  "keyAgreement",
  "keyCertSign",
  "cRLSign",
  "encipherOnly",
  "decipherOnly",
];

const ALG_OID: Record<string, string> = {
  "1.2.840.113549.1.1.1": "RSA",
  "1.2.840.113549.1.1.5": "RSA (SHA-1)",
  "1.2.840.113549.1.1.11": "RSA (SHA-256)",
  "1.2.840.113549.1.1.12": "RSA (SHA-384)",
  "1.2.840.113549.1.1.13": "RSA (SHA-512)",
  "1.2.840.10045.2.1": "ECDSA",
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
  "1.3.101.112": "Ed25519",
  "1.3.101.113": "Ed448",
};

type Asn1 = {
  /** Tag number (low 5 bits). */
  tag: number;
  /** Full first identifier octet (class + constructed + tag). */
  tagByte: number;
  constructed: boolean;
  value: Uint8Array;
};

function readLength(bytes: Uint8Array, offset: number): { length: number; size: number } {
  const first = bytes[offset];
  if (first < 0x80) return { length: first, size: 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 4) throw new Error("unsupported ASN.1 length");
  let length = 0;
  for (let i = 0; i < n; i++) length = (length << 8) | bytes[offset + 1 + i];
  return { length, size: 1 + n };
}

function parseAsn1(bytes: Uint8Array, offset = 0): { node: Asn1; next: number } {
  if (offset >= bytes.length) throw new Error("unexpected end of ASN.1");
  const tag = bytes[offset];
  const { length, size } = readLength(bytes, offset + 1);
  const start = offset + 1 + size;
  const end = start + length;
  if (end > bytes.length) throw new Error("ASN.1 length exceeds buffer");
  return {
    node: {
      tag: tag & 0x1f,
      tagByte: tag,
      constructed: (tag & 0x20) !== 0,
      value: bytes.subarray(start, end),
    },
    next: end,
  };
}

function parseSequence(bytes: Uint8Array): Asn1[] {
  const out: Asn1[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const { node, next } = parseAsn1(bytes, offset);
    out.push(node);
    offset = next;
  }
  return out;
}

function expectTag(node: Asn1, tag: number, label: string): void {
  if (node.tag !== tag) throw new Error(`expected ${label}`);
}

function decodeOid(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = (value << 7) | (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function decodePrintable(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return Array.from(bytes)
      .map((b) => String.fromCharCode(b))
      .join("");
  }
}

function decodeIntegerHex(bytes: Uint8Array): string {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return Array.from(bytes.subarray(start))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
}

function parseTime(node: Asn1): Date {
  const raw = decodePrintable(node.value);
  // UTCTime YYMMDDHHMMSSZ or GeneralizedTime YYYYMMDDHHMMSSZ
  let y: number;
  let rest: string;
  if (node.tag === 0x17) {
    // UTCTime
    const yy = Number(raw.slice(0, 2));
    y = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = raw.slice(2);
  } else if (node.tag === 0x18) {
    y = Number(raw.slice(0, 4));
    rest = raw.slice(4);
  } else {
    throw new Error("unsupported time encoding");
  }
  const mo = Number(rest.slice(0, 2)) - 1;
  const d = Number(rest.slice(2, 4));
  const h = Number(rest.slice(4, 6));
  const mi = Number(rest.slice(6, 8));
  const s = Number(rest.slice(8, 10) || "0");
  return new Date(Date.UTC(y, mo, d, h, mi, s));
}

function parseName(node: Asn1): string {
  expectTag(node, 0x10, "Name");
  const rdns = parseSequence(node.value);
  const parts: string[] = [];
  for (const rdn of rdns) {
    const attrs = parseSequence(rdn.value);
    for (const attrSet of attrs) {
      const seq = parseSequence(attrSet.value);
      if (seq.length < 2) continue;
      expectTag(seq[0], 0x06, "OID");
      const oid = decodeOid(seq[0].value);
      const label = ATTR_OID[oid] || oid;
      const value = decodePrintable(seq[1].value);
      parts.push(`${label}=${value}`);
    }
  }
  return parts.join(", ");
}

function parseBitStringUnused(node: Asn1): { unused: number; bits: Uint8Array } {
  expectTag(node, 0x03, "BIT STRING");
  if (!node.value.length) return { unused: 0, bits: new Uint8Array() };
  return { unused: node.value[0], bits: node.value.subarray(1) };
}

function parseSan(extValue: Uint8Array): {
  dnsNames: string[];
  ipAddresses: string[];
  emails: string[];
  uris: string[];
} {
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  const emails: string[] = [];
  const uris: string[] = [];
  const { node } = parseAsn1(extValue, 0);
  const names = parseSequence(node.value);
  for (const name of names) {
    // Context-specific tags in GeneralName
    const tag = name.tag;
    const text = decodePrintable(name.value);
    if (tag === 2) dnsNames.push(text);
    else if (tag === 1) emails.push(text);
    else if (tag === 6) uris.push(text);
    else if (tag === 7) {
      if (name.value.length === 4) {
        ipAddresses.push(Array.from(name.value).join("."));
      } else if (name.value.length === 16) {
        const hex = Array.from(name.value)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const groups = hex.match(/.{1,4}/g) || [];
        ipAddresses.push(groups.join(":"));
      }
    }
  }
  return { dnsNames, ipAddresses, emails, uris };
}

function parseKeyUsage(extValue: Uint8Array): string[] {
  const { node } = parseAsn1(extValue, 0);
  const { bits } = parseBitStringUnused(node);
  const out: string[] = [];
  for (let i = 0; i < KEY_USAGE_BITS.length; i++) {
    const byte = bits[Math.floor(i / 8)] ?? 0;
    const bit = 7 - (i % 8);
    if (byte & (1 << bit)) out.push(KEY_USAGE_BITS[i]);
  }
  return out;
}

function parseBasicConstraints(extValue: Uint8Array): boolean {
  const { node } = parseAsn1(extValue, 0);
  if (node.tag !== 0x10) return false;
  const seq = parseSequence(node.value);
  for (const child of seq) {
    if (child.tag === 0x01) return child.value.length > 0 && child.value[0] !== 0;
  }
  return false;
}

function describePublicKey(spki: Asn1): string {
  const seq = parseSequence(spki.value);
  if (!seq.length) return "Unknown";
  const algSeq = parseSequence(seq[0].value);
  if (!algSeq.length) return "Unknown";
  const algOid = decodeOid(algSeq[0].value);
  let label = ALG_OID[algOid] || algOid;
  if (algOid === "1.2.840.10045.2.1" && algSeq.length > 1 && algSeq[1].tag === 0x06) {
    const curve = decodeOid(algSeq[1].value);
    label = `ECDSA ${ALG_OID[curve] || curve}`;
  } else if (algOid === "1.2.840.113549.1.1.1" && seq.length > 1) {
    try {
      const { bits } = parseBitStringUnused(seq[1]);
      const { node: rsaKey } = parseAsn1(bits, 0);
      const rsaSeq = parseSequence(rsaKey.value);
      if (rsaSeq.length && rsaSeq[0].tag === 0x02) {
        const bitLen = Math.max(
          0,
          (rsaSeq[0].value.length - (rsaSeq[0].value[0] === 0 ? 1 : 0)) * 8,
        );
        label = `RSA ${bitLen}`;
      }
    } catch {
      /* keep base label */
    }
  }
  return label;
}

async function sha256Fingerprint(der: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", der.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
}

export async function parseCertificateDer(der: Uint8Array): Promise<CertificateInfo> {
  const { node: cert } = parseAsn1(der, 0);
  expectTag(cert, 0x10, "Certificate");
  const top = parseSequence(cert.value);
  if (top.length < 1) throw new Error("empty certificate");
  const tbs = top[0];
  expectTag(tbs, 0x10, "TBSCertificate");
  const fields = parseSequence(tbs.value);

  let idx = 0;
  // optional version [0] EXPLICIT
  if (fields[0]?.tagByte === 0xa0) idx = 1;

  const serialNode = fields[idx++];
  expectTag(serialNode, 0x02, "serialNumber");
  const serialNumber = decodeIntegerHex(serialNode.value);

  idx++; // signature algorithm
  const issuer = parseName(fields[idx++]);
  const validitySeq = parseSequence(fields[idx++].value);
  if (validitySeq.length < 2) throw new Error("invalid validity");
  const notBefore = parseTime(validitySeq[0]);
  const notAfter = parseTime(validitySeq[1]);
  const subject = parseName(fields[idx++]);
  const publicKeyAlgorithm = describePublicKey(fields[idx++]);

  let dnsNames: string[] = [];
  let ipAddresses: string[] = [];
  let emails: string[] = [];
  let uris: string[] = [];
  let isCA = false;
  let keyUsage: string[] = [];

  // remaining: issuerUniqueID [1], subjectUniqueID [2], extensions [3]
  for (; idx < fields.length; idx++) {
    const field = fields[idx];
    if (field.tagByte !== 0xa3) continue;
    let extBytes = field.value;
    try {
      const maybe = parseAsn1(field.value, 0).node;
      if (maybe.tag === 0x10) extBytes = maybe.value;
    } catch {
      /* use as-is */
    }
    let extensions: Asn1[];
    try {
      extensions = parseSequence(extBytes);
    } catch {
      continue;
    }
    for (const ext of extensions) {
      if (ext.tag !== 0x10) continue;
      const parts = parseSequence(ext.value);
      if (parts.length < 2) continue;
      const oid = decodeOid(parts[0].value);
      const valueNode = parts.find((p) => p.tag === 0x04);
      if (!valueNode) continue;
      try {
        if (oid === EXT_SAN) {
          ({ dnsNames, ipAddresses, emails, uris } = parseSan(valueNode.value));
        } else if (oid === EXT_KEY_USAGE) {
          keyUsage = parseKeyUsage(valueNode.value);
        } else if (oid === EXT_BASIC_CONSTRAINTS) {
          isCA = parseBasicConstraints(valueNode.value);
        }
      } catch {
        /* ignore bad extension */
      }
    }
  }

  return {
    subject,
    issuer,
    serialNumber,
    notBefore,
    notAfter,
    dnsNames,
    ipAddresses,
    emails,
    uris,
    fingerprintSha256: await sha256Fingerprint(der),
    publicKeyAlgorithm,
    isCA,
    keyUsage,
  };
}

const PEM_RE = /-----BEGIN ([^-]+)-----([A-Za-z0-9+/=\s]+)-----END \1-----/g;

export function extractPemBlocks(text: string): ParsedPemBlock[] {
  const blocks: ParsedPemBlock[] = [];
  for (const match of text.matchAll(PEM_RE)) {
    const type = match[1].trim();
    const b64 = match[2].replace(/\s+/g, "");
    try {
      const binary = atob(b64);
      const der = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      blocks.push({ label: type, type, der });
    } catch {
      /* skip bad block */
    }
  }
  return blocks;
}

function looksLikeDerCertificate(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x30) return false;
  try {
    const { node, next } = parseAsn1(bytes, 0);
    return node.tag === 0x10 && next > 0;
  } catch {
    return false;
  }
}

export function decodeSecretValue(encoded: string): string {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return encoded;
  }
}

export function decodeSecretBytes(encoded: string): Uint8Array | null {
  try {
    const binary = atob(encoded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const CERT_KEY_RE = /^(tls\.crt|ca\.crt|.+\.(crt|pem|cert))$/i;
const KEY_KEY_RE = /^(tls\.key|ca\.key|.+\.(key|pkcs8))$/i;

export function isCertificateDataKey(key: string): boolean {
  return CERT_KEY_RE.test(key);
}

export function isPrivateKeyDataKey(key: string): boolean {
  return KEY_KEY_RE.test(key);
}

export async function parseCertificatesFromPemOrDer(
  textOrDer: string | Uint8Array,
): Promise<CertificateInfo[]> {
  if (typeof textOrDer !== "string") {
    if (!looksLikeDerCertificate(textOrDer)) return [];
    return [await parseCertificateDer(textOrDer)];
  }
  const blocks = extractPemBlocks(textOrDer).filter((b) => /CERTIFICATE/i.test(b.type));
  if (blocks.length) {
    const out: CertificateInfo[] = [];
    for (const block of blocks) {
      out.push(await parseCertificateDer(block.der));
    }
    return out;
  }
  const trimmed = textOrDer.trim();
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 64) {
    try {
      const binary = atob(trimmed.replace(/\s+/g, ""));
      const der = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      if (looksLikeDerCertificate(der)) return [await parseCertificateDer(der)];
    } catch {
      /* ignore */
    }
  }
  return [];
}

export async function collectSecretCertificates(
  data: Record<string, string> | undefined,
): Promise<SecretCertEntry[]> {
  if (!data) return [];
  const entries: SecretCertEntry[] = [];
  const keys = Object.keys(data).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    if (
      !isCertificateDataKey(key) &&
      !/CERTIFICATE/i.test(decodeSecretValue(data[key]).slice(0, 80))
    ) {
      continue;
    }
    const decoded = decodeSecretValue(data[key]);
    try {
      let certs = await parseCertificatesFromPemOrDer(decoded);
      if (!certs.length) {
        const raw = decodeSecretBytes(data[key]);
        if (raw) certs = await parseCertificatesFromPemOrDer(raw);
      }
      if (certs.length) {
        entries.push({ key, certificates: certs });
      } else if (isCertificateDataKey(key)) {
        entries.push({ key, certificates: [], parseError: "No certificate found in value" });
      }
    } catch (e) {
      entries.push({
        key,
        certificates: [],
        parseError: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return entries;
}

export function summarizeSecretKeys(data: Record<string, string> | undefined): SecretKeySummary[] {
  if (!data) return [];
  return Object.keys(data)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const decoded = decodeSecretValue(data[key]);
      if (isPrivateKeyDataKey(key) || /PRIVATE KEY/i.test(decoded.slice(0, 80))) {
        const blocks = extractPemBlocks(decoded);
        const type = blocks[0]?.type || "Private Key";
        return { key, kind: "private-key" as const, detail: type };
      }
      if (isCertificateDataKey(key) || /CERTIFICATE/i.test(decoded.slice(0, 80))) {
        const count = extractPemBlocks(decoded).filter((b) => /CERTIFICATE/i.test(b.type)).length;
        return {
          key,
          kind: "certificate" as const,
          detail: count > 1 ? `${count} certificates (chain)` : "Certificate",
        };
      }
      return { key, kind: "other" as const, detail: `${decoded.length} bytes decoded` };
    });
}

export function certValidityTone(notBefore: Date, notAfter: Date, now = new Date()): CertTone {
  if (now.getTime() < notBefore.getTime()) return "idle";
  if (now.getTime() > notAfter.getTime()) return "err";
  const msLeft = notAfter.getTime() - now.getTime();
  const daysLeft = msLeft / (24 * 60 * 60 * 1000);
  if (daysLeft <= 14) return "err";
  if (daysLeft <= 30) return "warn";
  return "ok";
}

export function formatCertValidityLabel(notBefore: Date, notAfter: Date, now = new Date()): string {
  if (now.getTime() < notBefore.getTime()) {
    return `Not yet valid · starts ${formatCertDate(notBefore)}`;
  }
  if (now.getTime() > notAfter.getTime()) {
    const days = Math.ceil((now.getTime() - notAfter.getTime()) / (24 * 60 * 60 * 1000));
    return `Expired ${days}d ago`;
  }
  const days = Math.ceil((notAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 1) return "Expires today";
  return `Expires in ${days}d`;
}

export function formatCertDate(d: Date): string {
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function validityProgress(notBefore: Date, notAfter: Date, now = new Date()): number {
  const start = notBefore.getTime();
  const end = notAfter.getTime();
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
}

export function leafCertificate(certs: CertificateInfo[]): CertificateInfo | undefined {
  return certs.find((c) => !c.isCA) || certs[0];
}

/** Sync validity-only parse for list columns (skips fingerprint / extensions). */
export function notAfterFromCertificateDer(der: Uint8Array): Date | null {
  try {
    const { node: cert } = parseAsn1(der, 0);
    expectTag(cert, 0x10, "Certificate");
    const top = parseSequence(cert.value);
    const tbs = top[0];
    expectTag(tbs, 0x10, "TBSCertificate");
    const fields = parseSequence(tbs.value);
    let idx = 0;
    if (fields[0]?.tagByte === 0xa0) idx = 1;
    idx++; // serial
    idx++; // signature
    idx++; // issuer
    const validitySeq = parseSequence(fields[idx].value);
    if (validitySeq.length < 2) return null;
    return parseTime(validitySeq[1]);
  } catch {
    return null;
  }
}

export function notAfterFromPemOrDer(textOrDer: string | Uint8Array): Date | null {
  if (typeof textOrDer !== "string") {
    return notAfterFromCertificateDer(textOrDer);
  }
  const blocks = extractPemBlocks(textOrDer).filter((b) => /CERTIFICATE/i.test(b.type));
  if (blocks.length) return notAfterFromCertificateDer(blocks[0].der);
  try {
    const binary = atob(textOrDer.trim().replace(/\s+/g, ""));
    const der = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (der[0] === 0x30) return notAfterFromCertificateDer(der);
  } catch {
    /* ignore */
  }
  return null;
}

export function notAfterFromSecretData(data: Record<string, string> | undefined): Date | null {
  if (!data) return null;
  const preferred = ["tls.crt", "ca.crt"];
  const keys = [
    ...preferred.filter((k) => k in data),
    ...Object.keys(data)
      .filter((k) => !preferred.includes(k) && isCertificateDataKey(k))
      .sort((a, b) => a.localeCompare(b)),
  ];
  for (const key of keys) {
    const decoded = decodeSecretValue(data[key]);
    const blocks = extractPemBlocks(decoded).filter((b) => /CERTIFICATE/i.test(b.type));
    if (blocks.length) {
      const after = notAfterFromCertificateDer(blocks[0].der);
      if (after) return after;
    }
    const raw = decodeSecretBytes(data[key]);
    if (raw && raw[0] === 0x30) {
      const after = notAfterFromCertificateDer(raw);
      if (after) return after;
    }
  }
  return null;
}

function parseStatusTime(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Best-effort certificate expiry for list rows (Secret / Certificate / CertificateRequest). */
export function certificateExpiryFromObject(
  obj: {
    kind?: string;
    apiVersion?: string;
    type?: unknown;
    data?: unknown;
    spec?: unknown;
    status?: unknown;
  } | null,
): Date | null {
  if (!obj) return null;
  const kind = obj.kind;
  const status = obj.status as Record<string, unknown> | undefined;

  if (kind === "Certificate" || kind === "CertificateRequest") {
    const fromStatus = parseStatusTime(status?.notAfter);
    if (fromStatus) return fromStatus;
  }

  if (kind === "CertificateRequest") {
    const cert = status?.certificate;
    if (typeof cert === "string" && cert) {
      const decoded = decodeSecretValue(cert);
      const after = notAfterFromPemOrDer(decoded);
      if (after) return after;
      const raw = decodeSecretBytes(cert);
      if (raw) {
        const afterDer = notAfterFromCertificateDer(raw);
        if (afterDer) return afterDer;
      }
    }
  }

  if (kind === "Secret") {
    const data = obj.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (typeof v === "string") map[k] = v;
      }
      return notAfterFromSecretData(map);
    }
  }

  return null;
}

export function expiryTone(notAfter: Date, now = new Date()): CertTone {
  if (now.getTime() > notAfter.getTime()) return "err";
  const daysLeft = (notAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  if (daysLeft <= 14) return "err";
  if (daysLeft <= 30) return "warn";
  return "ok";
}

export function formatExpiryListLabel(notAfter: Date, now = new Date()): string {
  if (now.getTime() > notAfter.getTime()) {
    const days = Math.ceil((now.getTime() - notAfter.getTime()) / (24 * 60 * 60 * 1000));
    return days <= 1 ? "expired" : `expired ${days}d`;
  }
  const days = Math.ceil((notAfter.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 1) return "today";
  return `${days}d`;
}
