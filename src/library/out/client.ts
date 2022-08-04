import type * as HTTP2 from 'http2';

import _ from 'lodash';
import ms from 'ms';
import * as x from 'x-value';

import {BatchScheduler} from '../@utils';
import type {Router} from '../router';

import {Session} from './session';

const CREATE_SESSION_DEBOUNCE = ms('1s');

const PRINT_ACTIVE_STREAMS_TIME_SPAN = ms('5s');

const SESSION_CANDIDATES_DEFAULT = 1;
const SESSION_PRIORITY_DEFAULT = 0;

const DEFAULT_DEACTIVATING_LATENCY_MULTIPLIER = 1;

export const ClientOptions = x.object({
  label: x.string.optional(),
  password: x.string.optional(),
  /**
   * 代理入口服务器，如 "https://example.com:8443"。
   */
  authority: x.string,
  rejectUnauthorized: x.boolean.optional(),
  /**
   * 候选连接数量，默认为 1。
   */
  candidates: x.number.optional(),
  /**
   * 优先级，数字越大优先级越高，当存在多个不同优先级的候选 session 时，仅在最高的优先级中选择其中一
   * 个，默认为 0。
   */
  priority: x.number.optional(),
  activationLatency: x.number.optional(),
  deactivationLatency: x.number.optional(),
});

export type ClientOptions = x.TypeOf<typeof ClientOptions>;

export class Client {
  private sessions: Session[] = [];

  readonly label: string;

  readonly password: string | undefined;
  readonly priority: number;
  readonly activationLatency: number | undefined;
  readonly deactivationLatency: number | undefined;

  readonly connectAuthority: string;
  readonly connectOptions: HTTP2.SecureClientSessionOptions;

  readonly candidates: number;

  private createSessionScheduler = new BatchScheduler(() => {
    let sessions = this.sessions;

    sessions.push(new Session(this));

    console.info(
      `(${this.label}) new session created, ${sessions.length} in total.`,
    );

    if (sessions.length < this.candidates) {
      this.scheduleSessionCreation();
    }
  }, CREATE_SESSION_DEBOUNCE);

  private activeStreamEntrySet = new Set<ActiveStreamEntry>();

  private printActiveStreamsScheduler = new BatchScheduler(() => {
    let activeStreamEntrySet = this.activeStreamEntrySet;

    if (activeStreamEntrySet.size === 0) {
      return;
    }

    console.debug();
    console.debug(
      `(${this.label})[session:push(stream)] read/write in/out name`,
    );

    for (let {type, description, id, stream} of activeStreamEntrySet) {
      console.debug(
        `  [${id}(${stream.id})] ${stream.readable ? 'r' : '-'}${
          stream.writable ? 'w' : '-'
        } ${type === 'request' ? '>>>' : '<<<'} ${description}`,
      );
    }

    console.debug();
  }, PRINT_ACTIVE_STREAMS_TIME_SPAN);

  constructor(readonly router: Router, readonly options: ClientOptions) {
    let {
      label = '-',
      authority,
      rejectUnauthorized,
      password,
      candidates = SESSION_CANDIDATES_DEFAULT,
      priority = SESSION_PRIORITY_DEFAULT,
      activationLatency,
      deactivationLatency = typeof activationLatency === 'number'
        ? activationLatency * DEFAULT_DEACTIVATING_LATENCY_MULTIPLIER
        : undefined,
    } = options;

    this.label = label;

    this.password = password;

    this.connectAuthority = authority;
    this.connectOptions = {rejectUnauthorized};

    this.candidates = candidates;
    this.priority = priority;
    this.activationLatency = activationLatency;
    this.deactivationLatency = deactivationLatency;

    console.info(`(${label}) new client (authority ${this.connectAuthority}).`);

    this.scheduleSessionCreation();
  }

  removeSession(session: Session): void {
    let sessions = this.sessions;

    let index = sessions.indexOf(session);

    if (index < 0) {
      return;
    }

    sessions.splice(index, 1);

    console.info(
      `(${this.label}) removed 1 session, ${sessions.length} remains.`,
    );

    this.scheduleSessionCreation();
  }

  addActiveStream(
    type: 'request' | 'push',
    description: string,
    id: string,
    stream: HTTP2.ClientHttp2Stream,
  ): void {
    let activeStreamEntrySet = this.activeStreamEntrySet;

    let entry: ActiveStreamEntry = {
      type,
      description,
      id,
      stream,
    };

    activeStreamEntrySet.add(entry);

    stream
      .on('ready', () => {
        void this.printActiveStreamsScheduler.schedule();
      })
      .on('close', () => {
        activeStreamEntrySet.delete(entry);
        void this.printActiveStreamsScheduler.schedule();
      });

    void this.printActiveStreamsScheduler.schedule();
  }

  private scheduleSessionCreation(): void {
    void this.createSessionScheduler.schedule();
  }
}

interface ActiveStreamEntry {
  type: 'request' | 'push';
  description: string;
  id: string;
  stream: HTTP2.ClientHttp2Stream;
}
