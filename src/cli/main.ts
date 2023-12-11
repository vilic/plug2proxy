import {cosmiconfig} from 'cosmiconfig';
import SegfaultHandler from 'segfault-handler';
import * as x from 'x-value';

SegfaultHandler.registerHandler('plug2proxy-crash.log');

import {In, Out} from '../library/index.js';

import {setupIn} from './@in.js';
import {setupOut} from './@out.js';

process.on('warning', warning => console.warn(warning.stack));

const configExplorer = cosmiconfig('p2p');

const configPath = process.argv[2] as string | undefined;

const result =
  configPath === undefined
    ? await configExplorer.search()
    : await configExplorer.load(configPath);

if (!result) {
  console.error('config file not found.');
  process.exit(1);
}

const config = x
  .union([In.Config, Out.Config])
  .exact()
  .satisfies(result?.config);

switch (config.mode) {
  case 'in':
    await setupIn(config);
    break;
  case 'out':
    setupOut(config);
    break;
}
