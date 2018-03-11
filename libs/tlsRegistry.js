/*
  Service Discovery and Health Status
  Copyright (C) <2018> <Pablo Vicente>

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
const debug = require('debug')('SFC_registry');
const { groupBy } = require('lodash');

class TlSRegistry {
  constructor(tls, loki, fs, config) {
    this.config = config;
    this.tls = tls;
    this.fs = fs;
    this.Loki = loki;
    this.connection = null;
    this.totalNumberUpdatesSent = 0;
    this.db = null;
    this.serviceNetwork = null;
    this.server = null;
    this.cert = null;
    this.key = null;
    this.ca = null;

    this.readCerts();
    this.setupRegistryDB();
    this.setupRegistryCollection();
    this.createServer(tls);
    this.registerServerErrorListener();
  }

  readCerts() {
    this.key = this.fs.readFileSync(this.config.certKeyFile);
    this.cert = this.fs.readFileSync(this.config.certFile);
    this.ca = this.fs.readFileSync(this.config.ca);
  }

  createServer() {
    this.server = this.tls.createServer(
      {
        key: this.key,
        cert: this.cert,
        ca: this.ca,
        requestCert: true,
      },
      (socket) => {
        socket.on('data', (data) => {
          this.processPacket(data);
        });

        // Register a listener for disconnections so we can keep the "user" list updated
        socket.on('end', () => this.clientEndedConnection());
      },
    );
  }

  registerServerErrorListener() {
    this.server.on('error', error => this.handleServerError(error));
  }

  handleServerError(error) {
    if (this.makeServerThrow) {
      throw new Error(JSON.stringify(error));
    } else {
      debug('Something is wrong with the configuration or the environtment.....');
      debug(`Registry Server: ${error}!`);
      debug('^^^ Your configuration asked me not to throw but I will not work with this configuration!!!!!!!!!!');
    }
  }

  listen() {
    this.server.listen({ port: this.config.registryPort }, () => {});
  }

  processPacket(data) {
    const clientPacket = JSON.parse(data.toString());
    // Only insert a record if one doesn't exist already.
    if (!this.serviceExist(clientPacket.payload.groupingKey, clientPacket.payload.metrics.hostname)) {
      clientPacket.payload.online = true;
      this.serviceNetwork.insert(clientPacket.payload);
    } else {
      try {
        clientPacket.payload.online = true;
        this.updateServiceStatus(clientPacket.payload);
      } catch (err) {
        debug('Error updating record');
        debug(err);
      }
    }
  }

  clientEndedConnection() {
    this.totalNumberUpdatesSent += 1;
    debug(this.getServiceFleetStatus());
    debug('#'.repeat(220));
    debug('Total Requests: ', this.totalNumberUpdatesSent);
    debug('#'.repeat(220));
    debug('Client Disconected');
    this.markOfflineServices();
  }

  setupRegistryDB() {
    this.createDb(this.Loki, 'registry.db');
  }

  setupRegistryCollection() {
    this.serviceNetwork = this.db.addCollection('serviceNetwork', {
      indices: ['groupingKey', 'metrics.hostname'],
    });
  }

  createDb(Loki, dbName) {
    this.db = new Loki(dbName);
  }

  serviceExist(groupingKey, hostName) {
    return this.serviceNetwork.find({ groupingKey, 'metrics.hostname': hostName }).length > 0;
  }

  getServiceFleetStatus() {
    return groupBy(this.serviceNetwork.find(), aService => aService.groupingKey);
  }

  updateServiceStatus(serviceUpdate) {
    const current = this.serviceNetwork.findObject({
      groupingKey: serviceUpdate.groupingKey,
      'metrics.hostname': serviceUpdate.metrics.hostname,
    });

    if (current != null) {
      const currentKeys = Object.keys(current);
      currentKeys.forEach((aKey) => {
        if (aKey !== 'meta' && aKey !== '$loki') {
          current[aKey] = serviceUpdate[aKey];
        }
      });
      this.serviceNetwork.update(current);
    }
  }

  markOfflineServices() {
    const now = new Date().getTime() / 1000;
    const db = this.serviceNetwork.find();
    db.forEach((aRecord) => {
      // Calculate when the service should have reported. Give time for (big) network lag
      const shouldHaveReporterd = (new Date(aRecord.time) / 1000) + (aRecord.metrics.updateIntervalSeconds + 1.5);
      const reportInterval = aRecord.metrics.updateIntervalSeconds;
      debug(
        '|Service: ', aRecord.serviceName, '|host: ', aRecord.metrics.hostname, '|shouldHaveReported: ', shouldHaveReporterd,
        '|now: ', now, '|reportInterval: ', reportInterval, '|offline: ', (now - shouldHaveReporterd) > 0,
        '|Next update in: ', (now - shouldHaveReporterd),
      );
      if (now - shouldHaveReporterd > 0) {
        debug(aRecord.serviceName, aRecord.metrics.hostname, ' is offline');
        aRecord.online = false;
        this.updateServiceStatus(aRecord);
      }
    });
  }
}

module.exports = TlSRegistry;
