import type { EgressBudgetsV1, EgressRequestIntentV1, EgressTlsOriginV1 } from
  "../contracts/provider-process-egress-authorization-v1.js";

export const validRef = (value: string): boolean =>
  value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value) &&
  !value.includes("..");

export const validDigest = (value: string): boolean => /^sha256:[0-9a-f]{64}$/.test(value);

export const normalizeHostname = (value: string): string | undefined => {
  if (value.length < 1 || value.length > 253 || value.endsWith(".") || value.includes(":")) {return undefined;}
  const hostname = value.toLowerCase();
  if (hostname !== value || !hostname.includes(".")) {return undefined;}
  if (/^[0-9]+(?:\.[0-9]+){3}$/.test(hostname)) {return undefined;}
  const labels = hostname.split(".");
  if (labels.some(label => label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {return undefined;}
  return hostname;
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

export const validIntent = (intent: EgressRequestIntentV1): boolean =>
  ["DELETE", "GET", "PATCH", "POST", "PUT"].includes(intent.method) &&
  intent.pathAndQuery.length >= 1 && intent.pathAndQuery.length <= 16_384 &&
  intent.pathAndQuery.startsWith("/") && !intent.pathAndQuery.includes("#") &&
  ![...intent.pathAndQuery].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  }) &&
  validDigest(intent.bodyDigest) &&
  intent.mediaType.length >= 1 && intent.mediaType.length <= 128 &&
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(intent.mediaType) &&
  (intent.applicationProtocol === "http/1.1" || intent.applicationProtocol === "h2") &&
  intent.transportMode === "direct-tls" && intent.upgradeMode === "none";
