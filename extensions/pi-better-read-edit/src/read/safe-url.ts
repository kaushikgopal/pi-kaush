import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const DEFAULT_URL_BODY_CAP = 2 * 1024 * 1024;
export const DEFAULT_URL_REDIRECT_CAP = 5;

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

function unsafeIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 168 && b === 63 && c === 129 && parts[3] === 16) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(address: string): number[] | undefined {
  let source = address.toLowerCase().split("%", 1)[0]!;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source)?.[1];
  if (dotted) {
    if (unsafeIpv4(dotted) && isIP(dotted) !== 4) return undefined;
    const bytes = dotted.split(".").map(Number);
    source =
      source.slice(0, -dotted.length) +
      `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return undefined;
  const parts = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? omitted : 0 }, () => "0"),
    ...right,
  ].map((part) =>
    /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1,
  );
  return parts.length === 8 && parts.every((part) => part >= 0)
    ? parts
    : undefined;
}

export function isUnsafeAddress(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) return unsafeIpv4(address);
  if (family !== 6) return true;

  const parts = parseIpv6(address);
  if (!parts) return true;
  const [a, b, c, d, e, f, g, h] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const mappedOrCompatible =
    a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  const ipv4Translated =
    a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff;
  const globalUnicast = a >= 0x2000 && a <= 0x3fff;
  const ianaReserved = a === 0x2001 && b <= 0x01ff;
  return (
    !globalUnicast ||
    ianaReserved ||
    mappedOrCompatible ||
    ipv4Translated ||
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xffc0) === 0xfec0 ||
    (a & 0xff00) === 0xff00 ||
    (a === 0x2001 && b === 0x0db8) ||
    (a === 0x2001 && b === 0) ||
    a === 0x2002 ||
    (a === 0x3fff && b <= 0x0fff) ||
    (a === 0x0064 && b === 0xff9b) ||
    (a === 0x0100 && b === 0 && c === 0 && d === 0) ||
    (a === 0 &&
      b === 0 &&
      c === 0 &&
      d === 0 &&
      e === 0 &&
      f === 0 &&
      g === 0 &&
      (h === 0 || h === 1))
  );
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results
    .filter(
      (result): result is { address: string; family: 4 | 6 } =>
        result.family === 4 || result.family === 6,
    )
    .map(({ address, family }) => ({ address, family }));
}

async function validatedAddress(
  url: URL,
  resolver: HostResolver,
): Promise<ResolvedAddress> {
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  if (
    (url.protocol === "http:" && url.port && url.port !== "80") ||
    (url.protocol === "https:" && url.port && url.port !== "443")
  ) {
    throw new Error("URL reads only allow the standard HTTP and HTTPS ports.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error(`URL host '${hostname}' is not a public destination.`);
  }

  const literalFamily = isIP(hostname);
  const addresses: ResolvedAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname);
  if (addresses.length === 0) {
    throw new Error(`URL host '${hostname}' did not resolve.`);
  }
  if (addresses.some(({ address }) => isUnsafeAddress(address))) {
    throw new Error(`URL host '${hostname}' resolves to a non-public address.`);
  }
  return addresses[0]!;
}

function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("URL request aborted."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function requestOnce(
  url: URL,
  pinned: ResolvedAddress,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        agent: false,
        family: pinned.family,
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === "object" && lookupOptions.all) {
            (callback as any)(null, [pinned]);
          } else {
            (callback as any)(null, pinned.address, pinned.family);
          }
        },
        headers: {
          accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5",
          "user-agent": "pi-better-read-edit/0.1",
        },
      },
      (response) => {
        const body = Buffer.allocUnsafe(maxBytes);
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size + chunk.byteLength > maxBytes) {
            request.destroy(
              new Error(
                `URL response exceeds the ${maxBytes}-byte safety cap.`,
              ),
            );
            return;
          }
          chunk.copy(body, size);
          size += chunk.byteLength;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: body.subarray(0, size),
          }),
        );
        response.on("aborted", () =>
          reject(new Error("URL response aborted.")),
        );
        response.on("error", reject);
      },
    );
    request.setTimeout(30_000, () =>
      request.destroy(new Error("URL request timed out.")),
    );
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("URL protocol upgrades are not supported."));
    });
    request.on("error", reject);
    request.end();
  });
}

export async function safeFetchText(
  input: string,
  options: {
    signal?: AbortSignal;
    resolver?: HostResolver;
    maxBytes?: number;
    maxRedirects?: number;
  } = {},
): Promise<{ text: string; finalUrl: string; contentType?: string }> {
  const resolver = options.resolver ?? defaultResolver;
  const maxBytes = options.maxBytes ?? DEFAULT_URL_BODY_CAP;
  const maxRedirects = options.maxRedirects ?? DEFAULT_URL_REDIRECT_CAP;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 16 * 1024 * 1024
  ) {
    throw new Error(
      "URL body cap must be an integer between 1 byte and 16 MiB.",
    );
  }
  if (
    !Number.isSafeInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 20
  ) {
    throw new Error("URL redirect cap must be an integer between 0 and 20.");
  }
  const deadline = AbortSignal.timeout(30_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  let url = new URL(input);

  for (let redirects = 0; ; redirects++) {
    const pinned = await raceWithSignal(
      validatedAddress(url, resolver),
      signal,
    );
    const response = await requestOnce(url, pinned, signal, maxBytes);
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.location
    ) {
      if (redirects >= maxRedirects) {
        throw new Error(`URL exceeded ${maxRedirects} redirects.`);
      }
      const redirected = new URL(response.headers.location, url);
      if (url.protocol === "https:" && redirected.protocol !== "https:") {
        throw new Error("URL redirects may not downgrade HTTPS to HTTP.");
      }
      url = redirected;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`URL returned HTTP ${response.status}.`);
    }
    const contentType = response.headers["content-type"];
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(response.body),
      finalUrl: url.href,
      ...(typeof contentType === "string" ? { contentType } : {}),
    };
  }
}
