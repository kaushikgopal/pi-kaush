/**
 * Minimal CDP sender: satisfied by puppeteer's CDPSession, the daemon's
 * per-page session, and the client-side socket proxy.
 */
export interface CdpSender {
  send<T = unknown>(method: string, params?: object): Promise<T>;
}
