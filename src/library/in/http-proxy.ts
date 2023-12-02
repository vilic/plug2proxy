import * as HTTP from 'http';
import type * as Net from 'net';

import * as x from 'x-value';

import type {ConnectionId} from '../common.js';
import {ListeningHost, ListeningPort} from '../x.js';

import type {RequestProxy} from './request-proxy.js';
import type {TLSProxy} from './tls-proxy.js';
import type {TunnelServer} from './tunnel-server.js';

export const HTTPProxyOptions = x.object({
  host: ListeningHost.optional(),
  port: ListeningPort.optional(),
});

export type HTTPProxyOptions = x.TypeOf<typeof HTTPProxyOptions>;

export class HTTPProxy {
  readonly server: HTTP.Server;

  private lastContextIdNumber = 0;

  constructor(
    readonly tunnelServer: TunnelServer,
    readonly tlsProxy: TLSProxy,
    readonly netProxy: RequestProxy,
    {host, port}: HTTPProxyOptions,
  ) {
    this.server = HTTP.createServer()
      .on('connect', this.onHTTPServerConnect)
      .on('request', this.onHTTPServerRequest)
      .listen(port, host);
  }

  private onHTTPServerConnect = (
    request: HTTP.IncomingMessage,
    socket: Net.Socket,
  ): void => {
    const [host, portString] = request.url!.split(':');
    const port = parseInt(portString) || 443;

    socket.write('HTTP/1.1 200 OK\r\n\r\n');

    void this.tlsProxy.connect(this.getNextContextId(), socket, host, port);
  };

  private onHTTPServerRequest = (
    request: HTTP.IncomingMessage,
    response: HTTP.ServerResponse,
  ): void => {
    void this.netProxy.request(
      this.getNextContextId(),
      request,
      response,
      request.url!,
    );
  };

  private getNextContextId(): ConnectionId {
    return ++this.lastContextIdNumber as ConnectionId;
  }
}
