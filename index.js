'use strict';

const os = require('os');
const path = require('path');
const http = require('http');
const url = require('url');

const co = require('co');
const Promise = require('bluebird');
const Etcd = require('node-etcd');
const Docker = require('dockerode-bluebird');
const values = require('lodash').values;
const get = require('lodash').get;

const docker = new Docker({socketPath: '/var/run/docker.sock'});
const etcd = new Etcd();

const interfaces = os.networkInterfaces();
const iface = interfaces[process.env.INTERFACE || 'eth0'] || [];
const IP = (iface.find(i => i.family === 'IPv4') || {}).address;

if (!IP) {
  console.error('Interface not found');
  process.exit(255);
}

function check(forceVhost) {
  return co(function *() {
    const vhosts = {};
    const containers = yield docker.listContainersAsync({all: true});

    if (forceVhost && !vhosts[forceVhost]) {
      vhosts[forceVhost] = [];
    }

    const upstreams = etcd.getSync(`/vulcand/upstreams/`);
    if (upstreams.err) {
      throw upstreams.err;
    }

    if (upstreams.body && upstreams.body.node) {
      upstreams.body.node.nodes.forEach(node => {
        const endpoints = etcd.getSync(`${node.key}/endpoints`);
        if (!endpoints.err) {
          const nodes = get(endpoints, 'body.node.nodes', []);
          if (nodes.find(vnode => vnode.key.startsWith(`${node.key}/endpoints/${IP}`))) {
            const v = path.basename(node.key);
            vhosts[v] = [];
          }
        }
      });
    }

    yield Promise.each(containers, containerInfo => co(function *() {
      const container = docker.getContainer(containerInfo.Id);
      const info = yield container.inspectAsync();
      let vhost = info.Config.Env.map(env => {
        const keyVal = env.split('=');
        return {
          key: keyVal[0],
          value: keyVal[1]
        };
      }).find(env => env.key === 'VHOST');

      if (vhost) {
        vhost = vhost.value;

        if (!vhost || vhost === vhost) {
          const ports = values(info.NetworkSettings.Ports).filter(Boolean).map(port => port[0].HostPort);
          vhosts[vhost] = vhosts[vhost] || [];
          vhosts[vhost].push(...ports);
        }
      }
    }));

    yield Promise.each(Object.keys(vhosts), vhost =>{
      console.log(vhost);
      return co(function * () {
        const ports = vhosts[vhost];
        let backends = etcd.getSync(`/vulcand/upstreams/${vhost}/endpoints`);
        if (backends.err) {
          res.end(`vhost(${vhost}) not found`);
        } else {
          let activePorts = [];
          if (backends.body.node && backends.body.node.nodes) {
            activePorts = backends.body.node.nodes.filter(node => node.key.startsWith(`/vulcand/upstreams/${vhost}/endpoints/${IP}`)).map(node => {
              const key = path.basename(node.key).split('-');
              return key[1];
            });
          }
          const portsToBeAdded = ports.filter(port => activePorts.indexOf(port) === -1);
          const portsToBeRemoved = activePorts.filter(port => ports.indexOf(port) === -1);
          console.log(`Will add: ${portsToBeAdded.map(port => IP + ':' + port + ' ')}`);
          console.log(`Will remove: ${portsToBeRemoved.map(port => IP + ':' + port + '')}`);

          yield Promise.each(portsToBeAdded, port => new Promise((resolve, reject) => {
            etcd.setSync(`/vulcand/upstreams/${vhost}/endpoints/${IP}-${port}`, `http://${IP}:${port}`);
            resolve();
          }));
          yield Promise.each(portsToBeRemoved, port => new Promise((resolve, reject) => {
            etcd.delSync(`/vulcand/upstreams/${vhost}/endpoints/${IP}-${port}`);
            resolve();
          }));
        }
      });
    });
  })
}

const server = http.createServer((req, res) => {
  const requrl = url.parse(req.url, true);
  const query = requrl.query || {};

  check(query.vhost).then(() => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
  }).catch(e => {
    res.end(e.message);
    console.error(e.message);
  })
});


const PORT = process.env.PORT || 34567;
server.listen(PORT, () => {
  console.log('Listening on port  %d', PORT);

  check().catch(e => {
    console.error(e.message);
  });
});