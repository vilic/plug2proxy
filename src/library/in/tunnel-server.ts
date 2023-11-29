import assert from 'assert';
import * as HTTP2 from 'http2';
import type * as Net from 'net';
import type {Duplex} from 'stream';

import bytes from 'bytes';
import type {Duplexify} from 'duplexify';
import duplexify from 'duplexify';
import * as x from 'x-value';
import * as xn from 'x-value/node';

import type {LogContext} from '../@log.js';
import {Logs} from '../@log.js';
import type {
  TunnelId,
  TunnelInOutHeaderData,
  TunnelOutInHeaderData,
  TunnelStreamId,
} from '../common.js';
import {TUNNEL_HEADER_NAME} from '../common.js';
import type {RouteMatchOptions} from '../router.js';
import {IPPattern, Port} from '../x.js';

import type {Router} from './router/index.js';

const CONTEXT: LogContext = {
  type: 'tunnel-server',
};

const HOST_DEFAULT = '';
const PORT_DEFAULT = Port.nominalize(8443);

const WINDOW_SIZE = bytes('32MB');

export const TunnelServerOptions = x.object({
  host: x.union([IPPattern, x.literal('')]).optional(),
  port: Port.optional(),
  cert: x.union([x.string, xn.Buffer]).optional(),
  key: x.union([x.string, xn.Buffer]).optional(),
  password: x.string.optional(),
});

export type TunnelServerOptions = x.TypeOf<typeof TunnelServerOptions>;

export class TunnelServer {
  readonly server: HTTP2.Http2SecureServer;

  private tunnelMap = new Map<TunnelId, Tunnel>();
  private sessionToTunnelIdMap = new Map<HTTP2.Http2Session, TunnelId>();

  constructor(
    readonly router: Router,
    {
      host = HOST_DEFAULT,
      port = PORT_DEFAULT,
      cert,
      key,
      password,
    }: TunnelServerOptions,
  ) {
    this.server = HTTP2.createSecureServer({
      settings: {
        initialWindowSize: WINDOW_SIZE,
      },
      cert,
      key,
    })
      .on('session', session => {
        session.setLocalWindowSize(WINDOW_SIZE); // necessary?
      })
      .on('stream', (stream, headers) => {
        const data = JSON.parse(
          headers[TUNNEL_HEADER_NAME] as string,
        ) as TunnelOutInHeaderData;

        switch (data.type) {
          case 'tunnel':
            this.handleTunnel(data, stream);
            break;
          case 'out-in-stream':
            this.handleOutInStream(data, stream);
            break;
        }
      })
      .listen(port, host, () => {
        Logs.info(CONTEXT, `listening on ${host}:${port}...`);
      });
  }

  async connect(
    context: LogContext,
    tunnelId: TunnelId,
    host: string,
    port: number,
  ): Promise<Duplex> {
    const tunnel = this.tunnelMap.get(tunnelId);

    if (!tunnel) {
      throw new Error(`Tunnel ${tunnelId} not found.`);
    }

    const {tunnelStream} = tunnel;

    const id = ++tunnel.lastStreamIdNumber as TunnelStreamId;

    return new Promise((resolve, reject) => {
      tunnelStream.pushStream(
        {
          [TUNNEL_HEADER_NAME]: JSON.stringify({
            type: 'in-out-stream',
            id,
            host,
            port,
          } satisfies TunnelInOutHeaderData),
        },
        (error, inOutStream) => {
          if (error) {
            reject(error);
            return;
          }

          Logs.debug(context, `in-out-stream ${id}.`);

          // inOutStream.respond({':status': 200});

          const stream = duplexify(inOutStream);

          tunnel.connectionMap.set(id, {
            context,
            stream,
          });

          stream.on('close', () => {
            tunnel.connectionMap.delete(id);
          });

          resolve(stream);
        },
      );
    });
  }

  private handleTunnel(
    {routeMatchOptions}: TunnelOutInHeaderData & {type: 'tunnel'},
    stream: HTTP2.ServerHttp2Stream,
  ): void {
    const session = stream.session;

    assert(session);

    let id = this.sessionToTunnelIdMap.get(session);

    if (id === undefined) {
      id = this.getNextTunnelId();

      this.tunnelMap.set(id, {
        id,
        tunnelStream: stream,
        connectionMap: new Map(),
        lastStreamIdNumber: 0,
      });

      assert(stream.session);

      this.sessionToTunnelIdMap.set(stream.session, id);

      this.router.register(
        id,
        stream.session.socket!.remoteAddress!,
        routeMatchOptions,
      );

      stream.respond({':status': 200});
    } else {
      const tunnel = this.tunnelMap.get(id);

      assert(tunnel);

      this.router.update(id, routeMatchOptions);

      stream.respond({':status': 200}, {endStream: true});
    }
  }

  private handleOutInStream(
    {id}: TunnelOutInHeaderData & {type: 'out-in-stream'},
    stream: HTTP2.ServerHttp2Stream,
  ): void {
    assert(stream.session);

    const tunnelId = this.sessionToTunnelIdMap.get(stream.session);

    assert(tunnelId);

    const connection = this.tunnelMap.get(tunnelId)?.connectionMap.get(id);

    assert(connection);

    Logs.debug(connection.context, `out-in-stream ${id}.`);

    stream.on('data', console.log);

    connection.stream.setReadable(stream);

    stream.respond({':status': 200});
  }

  private lastTunnelIdNumber = 0;

  private getNextTunnelId(): TunnelId {
    return ++this.lastTunnelIdNumber as TunnelId;
  }
}

export type TunnelConnection = {
  context: LogContext;
  stream: Duplexify;
};

export type Tunnel = {
  id: TunnelId;
  tunnelStream: HTTP2.ServerHttp2Stream;
  connectionMap: Map<TunnelStreamId, TunnelConnection>;
  lastStreamIdNumber: number;
};
