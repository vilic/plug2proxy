import * as HTTP2 from 'http2';
import * as Net from 'net';
import {pipeline} from 'stream/promises';

import ms from 'ms';
import * as x from 'x-value';

import type {OutTunnelLogContext, OutTunnelStreamLogContext} from '../@log.js';
import {Logs} from '../@log.js';
import {getErrorCode, setupSessionPing} from '../@utils/index.js';
import type {TunnelInOutHeaderData, TunnelOutInHeaderData} from '../common.js';
import {
  CONNECTION_WINDOW_SIZE,
  STREAM_WINDOW_SIZE,
  TUNNEL_HEADER_NAME,
} from '../common.js';
import {RouteMatchOptions} from '../router.js';

const RECONNECT_DELAYS = [1000, 1000, 1000, 5000, 10_000, 30_000, 60_000];

function RECONNECT_DELAY(attempts: number): number {
  return RECONNECT_DELAYS[Math.min(attempts, RECONNECT_DELAYS.length - 1)];
}

export const TunnelConfig = x.object({
  routeMatchOptions: RouteMatchOptions,
});

export type TunnelConfig = x.TypeOf<typeof TunnelConfig>;

export const TunnelOptions = x.object({
  /**
   * 代理入口服务器，如 "https://example.com:8443"。
   */
  authority: x.string,
  rejectUnauthorized: x.boolean.optional(),
  config: TunnelConfig,
});

export type TunnelOptions = x.TypeOf<typeof TunnelOptions>;

export type TunnelId = x.Nominal<'tunnel id', number>;

export class Tunnel {
  readonly context: OutTunnelLogContext;

  readonly authority: string;

  readonly rejectUnauthorized: boolean;

  config: TunnelConfig;

  private session: HTTP2.ClientHttp2Session | undefined;

  private sessionConfigured = false;

  private continuousAttempts = 0;

  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: TunnelId,
    {authority, rejectUnauthorized = true, config}: TunnelOptions,
  ) {
    this.context = {
      type: 'out:tunnel',
      id,
    };

    this.authority = authority;
    this.rejectUnauthorized = rejectUnauthorized;
    this.config = config;

    this.connect();
  }

  configure(config: TunnelConfig): void {
    this.config = config;
    this._configure();
  }

  private connect(): void {
    const {context} = this;

    this.continuousAttempts++;

    const session = HTTP2.connect(this.authority, {
      rejectUnauthorized: this.rejectUnauthorized,
      settings: {
        initialWindowSize: STREAM_WINDOW_SIZE,
      },
    })
      .on('connect', session => {
        Logs.info(context, 'tunnel established.');

        session.setLocalWindowSize(CONNECTION_WINDOW_SIZE);

        setupSessionPing(session);

        this._configure();
      })
      .on('stream', (stream, headers) => {
        const data = JSON.parse(
          headers[TUNNEL_HEADER_NAME] as string,
        ) as TunnelInOutHeaderData;

        switch (data.type) {
          case 'in-out-stream':
            void this.handleInOutStream(data, stream, session);
            break;
        }
      })
      .on('close', () => {
        Logs.info(context, 'tunnel closed.');
        this.scheduleReconnect();
      })
      .on('error', error => {
        Logs.error(context, 'tunnel error.');
        Logs.debug(context, error);
      });

    this.session = session;
    this.sessionConfigured = false;
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);

    const delay = RECONNECT_DELAY(this.continuousAttempts);

    Logs.info(this.context, `reconnect in ${ms(delay)}...`);

    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private _configure(): void {
    const {session} = this;

    if (!session) {
      return;
    }

    const {config, sessionConfigured} = this;

    if (!sessionConfigured) {
      this.sessionConfigured = true;
    }

    const stream = session.request(
      {
        [TUNNEL_HEADER_NAME]: JSON.stringify({
          type: 'tunnel',
          ...config,
        } satisfies TunnelOutInHeaderData),
      },
      {endStream: true},
    );

    stream
      .on('response', headers => {
        if (sessionConfigured) {
          return;
        }

        if (headers[':status'] === 200) {
          this.continuousAttempts = 0;
        }
      })
      .on('close', () => {
        if (sessionConfigured) {
          return;
        }

        // Session 'close' event sometimes not emitted, don't know why.
        this.scheduleReconnect();
      })
      .on('error', error => {
        Logs.debug(this.context, error);
      });
  }

  private async handleInOutStream(
    {id, host, port}: TunnelInOutHeaderData,
    inOutStream: HTTP2.ClientHttp2Stream,
    session: HTTP2.ClientHttp2Session,
  ): Promise<void> {
    const context: OutTunnelStreamLogContext = {
      type: 'out:tunnel-stream',
      stream: id,
    };

    Logs.info(context, `received IN-OUT stream for ${host}:${port}.`);

    const proxyStream = Net.connect(port, host);

    const outInStream = session.request(
      {
        [TUNNEL_HEADER_NAME]: JSON.stringify({
          type: 'out-in-stream',
          id,
        } satisfies TunnelOutInHeaderData),
      },
      {endStream: false},
    );

    outInStream.on('response', headers => {
      if (headers[':status'] === 200) {
        Logs.info(context, 'OUT-IN stream established.');
      }
    });

    try {
      await Promise.all([
        pipeline(inOutStream, proxyStream),
        pipeline(proxyStream, outInStream),
      ]);

      Logs.info(context, 'OUT-IN stream closed.');
    } catch (error) {
      inOutStream.destroy();
      outInStream.destroy();
      proxyStream.destroy();

      if (getErrorCode(error) === 'ERR_STREAM_PREMATURE_CLOSE') {
        Logs.info(context, 'OUT-IN stream closed.');
      } else {
        Logs.warn(context, 'OUT-IN stream error.');
        Logs.debug(context, error);
      }
    }
  }
}
