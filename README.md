# 插入代理 Plug2Proxy

由出口服务器主动连接入口服务器实现流量代理的小工具，需要出口服务器能直链入口服务器。

## 特性

- 出口服务器无需暴露端口。
- 出口服务器挂了不需要修改入口服务器配置。

我主要是打算用于服务器下载加速。

## 用例

> 需安装 Node.js 较新版本，我用的 16。可使用 pm2 启动。

```sh
npm install --global plug2proxy
```

### 入口

```sh
plug2proxy out.p2p.js
```

配置文件 `in.p2p.js`，详见 [in/server.ts](./packages/plug2proxy/src/library/in/server.ts)、[in/proxy.ts](./packages/plug2proxy/src/library/in/proxy.ts)。

```js
const FS = require('fs');

module.exports = {
  mode: 'in',
  server: {
    password: '12345678',
    listen: {
      // 这是给代理出口连的端口。
      port: 8001,
    },
    tls: {
      // 可使用 acme.sh 等工具生成。
      cert: FS.readFileSync('server.crt'),
      key: FS.readFileSync('server.key'),
    },
  },
  proxy: {
    listen: {
      // 这是给终端连的端口。
      port: 8000,
    },
  },
};
```

### 出口

```sh
plug2proxy out.p2p.js
```

配置文件 `out.p2p.js`，详见 [router.ts](./packages/plug2proxy/src/library/router/router.ts)、[out/client.ts](./packages/plug2proxy/src/library/out/client.ts)。

```js
module.exports = {
  mode: 'out',
  router: {
    rules: [
      {
        type: 'geoip',
        match: 'CN',
        route: 'direct',
      },
      {
        type: 'ip',
        match: 'private',
        route: 'direct',
      },
    ],
    fallback: 'proxy',
    // MaxMind 数据库。
    geoIPDatabase: 'geoip.mmdb',
  },
  clients: [
    {
      password: '12345678',
      connect: {
        // 入口服务器连接参数。
        host: 'example.com',
        port: 8001,
      },
    },
  ],
};
```

## 路线图

- P2P 连接。
- 连接性能优化。

## 授权协议

MIT 协议
