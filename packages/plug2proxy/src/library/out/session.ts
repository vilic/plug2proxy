import * as HTTP from 'http';
import * as HTTP2 from 'http2';
import * as Net from 'net';

import {HOP_BY_HOP_HEADERS_REGEX} from '../@common';
import {groupRawHeaders} from '../@utils';
import {InRoute} from '../types';

import {Client} from './client';

export class Session {
  private id = ++Session.lastId;

  remoteAddress: string | undefined;

  private http2Client: HTTP2.ClientHttp2Session;

  constructor(readonly client: Client) {
    console.info('initializing session...');

    let http2Client = HTTP2.connect(
      client.connectAuthority,
      client.connectOptions,
    );

    http2Client
      .on('stream', (pushStream, headers) => {
        switch (headers.type) {
          case 'connect':
            void this.connect(pushStream, headers);
            break;
          case 'request':
            void this.request(pushStream, headers);
            break;
          case 'route':
            void this.route(pushStream, headers);
            break;
          default:
            console.error('received unexpected push stream:', headers.type);
            break;
        }
      })
      .on('close', () => {
        console.debug('session "close".');
        client.removeSession(this);
      })
      .on('error', error => {
        console.error('session error:', error.message);
        client.removeSession(this);
      });

    this.http2Client = http2Client;

    let sessionStream = this.requestServer(
      'session',
      {
        type: 'session',
        password: client.password,
      },
      {
        endStream: false,
      },
    );

    sessionStream
      .on('response', headers => {
        let status = headers[':status'];

        if (status === 200) {
          console.info('session ready.');
        } else {
          console.error(
            `session initialize error (${status}):`,
            headers.message,
          );
        }
      })
      .on('error', (error: any) => {
        console.error('session error:', error.message);
        http2Client.destroy();
      });
  }

  private async connect(
    pushStream: HTTP2.ClientHttp2Stream,
    {id, host, port}: HTTP2.IncomingHttpHeaders,
  ): Promise<void> {
    pushStream.close();

    let client = this.client;

    console.info('connect:', `${host}:${port}`);

    let route: string;

    try {
      route = await client.router.route(host!);
    } catch (error: any) {
      console.error('route error:', error.message);
      route = 'direct';
    }

    console.info(`connect routed ${host} to ${route}.`);

    if (route === 'direct') {
      let stream = this.requestServer(`connect-direct ${host}`, {
        id,
        type: 'connect-direct',
      });

      stream
        .on('end', () => {
          console.debug('connect-direct stream "end".');
        })
        .on('error', error => {
          console.error('connect-direct stream error:', error.message);
        });

      return;
    }

    console.debug(`connecting ${host}:${port}...`);

    let outSocket = Net.createConnection({host, port: Number(port)});
    let inStream: HTTP2.ClientHttp2Stream | undefined;

    outSocket.on('connect', () => {
      console.debug(`connected ${host}:${port}.`);

      inStream = this.requestServer(
        `connect-ok ${host}:${port}`,
        {
          id,
          type: 'connect-ok',
        },
        {
          endStream: false,
        },
      );

      outSocket.pipe(inStream);
      inStream.pipe(outSocket);

      inStream
        .on('close', () => {
          console.debug('in stream "close".');
        })
        .on('error', error => {
          console.error('in stream error:', error.message);
          outSocket.destroy();
        });
    });

    outSocket
      // OutSocket is a Duplex and in some case (e.g., some speed test
      // connection) it keeps open after the source ends. So we need to close
      // the source stream once writes finish.
      .on('finish', () => {
        console.debug('out socket "finish".');
        inStream?.close();
      })
      .on('close', () => {
        console.debug('out socket "close".');
        inStream?.close();
      })
      .on('error', (error: any) => {
        console.error('out socket error:', error.message);
        inStream?.close();
      });
  }

  private async request(
    requestStream: HTTP2.ClientHttp2Stream,
    {id, method, url, headers: headersJSON}: HTTP2.IncomingHttpHeaders,
  ): Promise<void> {
    console.info('request:', method, url);

    this.client.addActiveStream(
      'push',
      `request ${method} ${url}`,
      this.id,
      requestStream,
    );

    let headers = JSON.parse(headersJSON as string);

    let responded = false;

    let proxyRequest = HTTP.request(
      url as string,
      {
        method: method as string,
        headers,
      },
      proxyResponse => {
        let status = proxyResponse.statusCode!;

        console.debug('response received.');

        let headers: {[key: string]: string | string[]} = {};

        for (let [key, value] of groupRawHeaders(proxyResponse.rawHeaders)) {
          if (HOP_BY_HOP_HEADERS_REGEX.test(key)) {
            continue;
          }

          let existingValue = headers[key];

          if (Array.isArray(existingValue)) {
            existingValue.push(value);
          } else if (existingValue !== undefined) {
            headers[key] = [existingValue, value];
          } else {
            headers[key] = value;
          }
        }

        let responseStream = this.requestServer(
          `response-stream ${url}`,
          {
            id,
            type: 'response-stream',
            status,
            headers: JSON.stringify(headers),
          },
          {
            endStream: false,
          },
        );

        responded = true;

        proxyResponse.pipe(responseStream);

        proxyResponse
          .on('end', () => {
            console.debug('proxy response "end".');
          })
          .on('error', (error: any) => {
            console.error('proxy response error:', error.message);
            responseStream.close();
          });

        responseStream.on('error', error => {
          console.error('response stream error:', error.message);
          proxyResponse.destroy();
        });
      },
    );

    requestStream.pipe(proxyRequest);

    requestStream
      .on('end', () => {
        console.debug('request stream "end".');
      })
      .on('error', (error: any) => {
        console.error('request stream error:', error.message);
        proxyRequest.destroy();
      });

    proxyRequest.on('error', (error: any) => {
      console.error('proxy request error:', error.message);

      if (responded) {
        return;
      }

      let responseStream: HTTP2.ClientHttp2Stream;

      if (error.code === 'ENOTFOUND') {
        responseStream = this.requestServer(`response-stream (404) ${url}`, {
          id,
          type: 'response-stream',
          status: 404,
        });
      } else {
        responseStream = this.requestServer(`response-stream (500) ${url}`, {
          id,
          type: 'response-stream',
          status: 500,
        });
      }

      responseStream
        .on('end', () => {
          console.debug('error response stream "end".');
        })
        .on('error', error => {
          console.error('error response stream error:', error.message);
        });
    });
  }

  private async route(
    pushStream: HTTP2.ClientHttp2Stream,
    {id, host}: HTTP2.IncomingHttpHeaders,
  ): Promise<void> {
    pushStream.close();

    console.info('route:', host);

    let sourceRoute = await this.client.router.route(host!);

    let route: InRoute = sourceRoute === 'direct' ? 'direct' : 'proxy';

    console.info(`route routed ${host} to ${route}.`);

    let responseStream = this.requestServer(`route-result ${host}`, {
      id,
      type: 'route-result',
      route,
    });

    responseStream
      .on('end', () => {
        console.debug('route response stream "end".');
      })
      .on('error', error => {
        console.error('route response stream error:', error.message);
      });
  }

  private requestServer(
    description: string,
    headers: HTTP2.OutgoingHttpHeaders,
    options?: HTTP2.ClientSessionRequestOptions,
  ): HTTP2.ClientHttp2Stream {
    let stream = this.http2Client.request(headers, options);

    this.client.addActiveStream('request', description, this.id, stream);

    return stream;
  }

  private static lastId = 0;
}
