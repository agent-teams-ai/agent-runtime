import type { EgressBudgetsV1, EgressTlsOriginV1, TrustedHostRequestProjectionV1 } from
  "../contracts/provider-process-egress-authorization-v1.js";

export const validRef = (value: string): boolean =>
  value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value) &&
  !value.includes("..");

export const validDigest = (value: string): boolean => /^sha256:[0-9a-f]{64}$/.test(value);

export const normalizeHostname = (value: string): string | undefined => {
  if (value.length < 1 || value.length > 253 || value.endsWith(".") || value.includes(":")) {
    return undefined;
  }
  const hostname = value.toLowerCase();
  if (hostname !== value || !hostname.includes(".") || /^[0-9]+(?:\.[0-9]+){3}$/.test(hostname)) {
    return undefined;
  }
  const labels = hostname.split(".");
  return labels.some(label => label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ? undefined : hostname;
};

export const validOrigin = (origin: EgressTlsOriginV1): boolean =>
  origin.scheme === "https" && normalizeHostname(origin.hostname) === origin.hostname &&
  Number.isSafeInteger(origin.port) && origin.port >= 1 && origin.port <= 65_535;

export const validBudgets = (budgets: EgressBudgetsV1): boolean =>
  Number.isSafeInteger(budgets.requestBytes) && budgets.requestBytes >= 0 &&
  budgets.requestBytes <= 64 * 1024 * 1024 &&
  Number.isSafeInteger(budgets.responseBytes) && budgets.responseBytes >= 0 &&
  budgets.responseBytes <= 256 * 1024 * 1024 &&
  Number.isSafeInteger(budgets.totalMilliseconds) && budgets.totalMilliseconds >= 1 &&
  budgets.totalMilliseconds <= 15 * 60 * 1000;

const validPath = (value: string): boolean => value.length >= 1 && value.length <= 16_384 &&
  value.startsWith("/") && !value.includes("#") && ![...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
const validLength = (value: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const headerName = (value: string): boolean => value.length <= 128 &&
  /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(value);

export const validRequestProjection = (request: TrustedHostRequestProjectionV1): boolean => {
  if (!["DELETE", "GET", "PATCH", "POST", "PUT"].includes(request.method) ||
    request.scheme !== "https" || normalizeHostname(request.authority.hostname) !==
      request.authority.hostname || !validOrigin({ scheme: "https", ...request.authority }) ||
    !validPath(request.pathAndQuery) || !validDigest(request.headers.canonicalDigest) ||
    !validLength(request.headers.fieldCount, 256) || !validDigest(request.body.digest) ||
    !validLength(request.body.byteLength, 64 * 1024 * 1024)) {return false;}
  const credentialNames = request.headers.credentialFields.map(field => field.name);
  if (request.headers.credentialFields.length > request.headers.fieldCount ||
    new Set(credentialNames).size !== credentialNames.length ||
    credentialNames.some((name, index) => index > 0 && credentialNames[index - 1]! >= name) ||
    request.headers.credentialFields.some(field => !headerName(field.name) ||
      !validDigest(field.credentialBindingDigest) || !validDigest(field.valueDigest) ||
      !validLength(field.byteLength, 1024 * 1024))) {return false;}
  const framing = request.framing;
  if (framing.protocol !== "http/1.1") {return true;}
  return framing.requestTarget === "origin-form" && framing.authoritySource === "host" &&
    framing.transferEncoding === "absent" && framing.connectionSpecificHeaders === "absent" &&
    framing.contentLength === request.body.byteLength;
};
