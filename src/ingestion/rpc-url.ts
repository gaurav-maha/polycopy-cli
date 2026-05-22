export function deriveWsUrl(httpOrWsUrl: string): string {
  if (httpOrWsUrl.startsWith("wss://") || httpOrWsUrl.startsWith("ws://")) {
    return httpOrWsUrl;
  }
  if (httpOrWsUrl.startsWith("https://")) {
    return httpOrWsUrl.replace("https://", "wss://");
  }
  if (httpOrWsUrl.startsWith("http://")) {
    return httpOrWsUrl.replace("http://", "ws://");
  }
  return httpOrWsUrl;
}

export function resolveWsUrl(args: { wsUrl?: string; rpcUrl: string }): string {
  return deriveWsUrl(args.wsUrl ?? args.rpcUrl);
}
