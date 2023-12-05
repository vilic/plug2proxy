import assert from 'assert';
import * as HTTP2 from 'http2';
import type {Duplex} from 'stream';

import type {Duplexify} from 'duplexify';
import duplexify from 'duplexify';

import type {InLogContext} from '../@log/index.js';
import {
  IN_ROUTE_MATCH_OPTIONS,
  IN_TUNNEL_CLOSED,
  IN_TUNNEL_CONFIGURE_STREAM_ERROR,
  IN_TUNNEL_CONFIGURE_UPDATE_STREAM_ERROR,
  IN_TUNNEL_ESTABLISHED,
  IN_TUNNEL_IN_OUT_STREAM_ESTABLISHED,
  IN_TUNNEL_OUT_IN_STREAM_ESTABLISHED,
  IN_TUNNEL_PASSWORD_MISMATCH,
  IN_TUNNEL_SERVER_LISTENING_ON,
  IN_TUNNEL_SERVER_TUNNELING,
  IN_TUNNEL_STREAM_CLOSED,
  IN_TUNNEL_UPDATED,
  Logs,
} from '../@log/index.js';
import {setupSessionPing} from '../@utils/index.js';
import type {
  TunnelId,
  TunnelInOutHeaderData,
  TunnelOutInHeaderData,
  TunnelStreamId,
} from '../common.js';
import {
  CONNECTION_WINDOW_SIZE,
  STREAM_WINDOW_SIZE,
  TUNNEL_ERROR_HEADER_NAME,
  TUNNEL_HEADER_NAME,
  TUNNEL_PORT_DEFAULT,
} from '../common.js';
import type {ListeningHost, Port} from '../x.js';

import type {Router} from './router/index.js';

const MAX_OUTSTANDING_PINGS = 5;

const HOST_DEFAULT = '';

export type TunnelServerOptions = {
  host?: ListeningHost;
  port?: Port;
  cert: string | Buffer;
  key: string | Buffer;
  password?: string;
};

export class TunnelServer {
  readonly server: HTTP2.Http2SecureServer;

  readonly password: string | undefined;

  private tunnelMap = new Map<TunnelId, Tunnel>();
  private sessionToTunnelIdMap = new Map<HTTP2.Http2Session, TunnelId>();

  constructor(
    readonly router: Router,
    {
      host = HOST_DEFAULT,
      port = TUNNEL_PORT_DEFAULT,
      cert,
      key,
      password,
    }: TunnelServerOptions,
  ) {
    this.server = HTTP2.createSecureServer({
      settings: {
        initialWindowSize: STREAM_WINDOW_SIZE,
      },
      cert,
      key,
      maxOutstandingPings: MAX_OUTSTANDING_PINGS,
    })
      .on('session', session => {
        session.setLocalWindowSize(CONNECTION_WINDOW_SIZE);

        setupSessionPing(session);
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
        Logs.info('tunnel-server', IN_TUNNEL_SERVER_LISTENING_ON(host, port));
      });

    this.password = password;
  }

  async connect(
    upperContext: InLogContext,
    tunnelId: TunnelId,
    host: string,
    port: number,
  ): Promise<Duplex> {
    const tunnel = this.tunnelMap.get(tunnelId);

    assert(tunnel);

    const {tunnelStream} = tunnel;

    const id = ++tunnel.lastStreamIdNumber as TunnelStreamId;

    const context: InLogContext = {
      ...upperContext,
      tunnel: tunnelId,
      stream: id,
    };

    Logs.info(
      context,
      IN_TUNNEL_SERVER_TUNNELING(host, port, tunnel.remoteAddress),
    );

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

          Logs.debug(context, IN_TUNNEL_IN_OUT_STREAM_ESTABLISHED);

          const stream = duplexify(inOutStream);

          tunnel.connectionMap.set(id, {
            context,
            stream,
          });

          stream.on('close', () => {
            Logs.debug(context, IN_TUNNEL_STREAM_CLOSED);
            tunnel.connectionMap.delete(id);
          });

          resolve(stream);
        },
      );
    });
  }

  private handleTunnel(
    {routeMatchOptions, password}: TunnelOutInHeaderData & {type: 'tunnel'},
    stream: HTTP2.ServerHttp2Stream,
  ): void {
    const session = stream.session;

    assert(session);

    let id = this.sessionToTunnelIdMap.get(session);

    if (id === undefined) {
      if (password !== this.password) {
        Logs.error(
          'tunnel-server',
          IN_TUNNEL_PASSWORD_MISMATCH(session.socket!.remoteAddress!),
        );

        stream.respond(
          {':status': 401, [TUNNEL_ERROR_HEADER_NAME]: 'password mismatch.'},
          {endStream: true},
        );
        session.close();
        return;
      }

      id = this.getNextTunnelId();

      const context: InLogContext = {
        type: 'in',
        tunnel: id,
      };

      this.tunnelMap.set(id, {
        id,
        remoteAddress: session.socket!.remoteAddress!,
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

      stream
        .on('close', () => {
          this.tunnelMap.delete(id!);
          this.sessionToTunnelIdMap.delete(session);
          this.router.unregister(id!);

          Logs.info(context, IN_TUNNEL_CLOSED);
        })
        .on('error', error => {
          Logs.error(context, IN_TUNNEL_CONFIGURE_STREAM_ERROR(error));
          Logs.debug(context, error);
        });

      stream.respond({':status': 200});

      Logs.info(context, IN_TUNNEL_ESTABLISHED);
      Logs.debug(context, IN_ROUTE_MATCH_OPTIONS, routeMatchOptions);
    } else {
      const context: InLogContext = {
        type: 'in',
        tunnel: id,
      };

      const tunnel = this.tunnelMap.get(id);

      assert(tunnel);

      this.router.update(id, routeMatchOptions);

      stream.on('error', error => {
        Logs.error(context, IN_TUNNEL_CONFIGURE_UPDATE_STREAM_ERROR(error));
        Logs.debug(context, error);
      });

      stream.respond({':status': 200}, {endStream: true});

      Logs.info(context, IN_TUNNEL_UPDATED);
      Logs.debug(context, IN_ROUTE_MATCH_OPTIONS, routeMatchOptions);
    }
  }

  private handleOutInStream(
    {id}: TunnelOutInHeaderData & {type: 'out-in-stream'},
    stream: HTTP2.ServerHttp2Stream,
  ): void {
    const {session} = stream;

    assert(session);

    const tunnelId = this.sessionToTunnelIdMap.get(session);

    if (tunnelId === undefined) {
      // Should not receive out-in-stream request for tunnel not configured.
      session.close();
      return;
    }

    const connection = this.tunnelMap.get(tunnelId)?.connectionMap.get(id);

    assert(connection);

    Logs.debug(connection.context, IN_TUNNEL_OUT_IN_STREAM_ESTABLISHED);

    connection.stream.setReadable(stream);

    stream.respond({':status': 200});
  }

  private lastTunnelIdNumber = 0;

  private getNextTunnelId(): TunnelId {
    return ++this.lastTunnelIdNumber as TunnelId;
  }
}

export type TunnelConnection = {
  context: InLogContext;
  stream: Duplexify;
};

export type Tunnel = {
  id: TunnelId;
  remoteAddress: string;
  tunnelStream: HTTP2.ServerHttp2Stream;
  connectionMap: Map<TunnelStreamId, TunnelConnection>;
  lastStreamIdNumber: number;
};
