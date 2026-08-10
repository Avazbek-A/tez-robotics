import { describe, it, beforeAll, afterAll } from 'vitest';
import * as mqtt from 'mqtt';
import { startDevBroker, type DevBrokerResult } from '../src/dev-broker';

const EXTERNAL_MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const CONNECT_TIMEOUT = 500;

async function isBrokerReachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = mqtt.connect(url, {
      connectTimeout: CONNECT_TIMEOUT,
      reconnectPeriod: 0,
    });

    const timer = setTimeout(() => {
      client.end(true);
      resolve(false);
    }, CONNECT_TIMEOUT + 100);

    client.on('connect', () => {
      clearTimeout(timer);
      client.end(true);
      resolve(true);
    });

    client.on('error', () => {
      clearTimeout(timer);
      client.end(true);
      resolve(false);
    });
  });
}

describe('MQTT Broker - Dev (Local aedes)', () => {
  let devBroker: DevBrokerResult;

  beforeAll(async () => {
    devBroker = await startDevBroker();
    console.log(`Dev broker started on ${devBroker.url}`);
  });

  afterAll(async () => {
    if (devBroker) {
      await devBroker.close();
      console.log('Dev broker closed');
    }
  });

  it('should complete pub/sub roundtrip on test/ping topic within 2s', async ({ expect }) => {
    const client = mqtt.connect(devBroker.url, {
      connectTimeout: CONNECT_TIMEOUT,
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end(true);
        reject(new Error('Dev broker roundtrip timeout - no response within 2s'));
      }, 2000);

      let messageReceived = false;

      client.on('connect', () => {
        client.subscribe('test/ping', (err) => {
          if (err) {
            clearTimeout(timeout);
            client.end(true);
            reject(err);
            return;
          }

          // Publish a test message
          client.publish('test/ping', 'pong', (err) => {
            if (err) {
              clearTimeout(timeout);
              client.end(true);
              reject(err);
            }
          });
        });
      });

      client.on('message', (topic, message) => {
        if (topic === 'test/ping' && message.toString() === 'pong' && !messageReceived) {
          messageReceived = true;
          clearTimeout(timeout);
          client.end(true);
          resolve();
        }
      });

      client.on('error', (error) => {
        clearTimeout(timeout);
        client.end(true);
        reject(error);
      });
    });
  });

  it('should complete pub/sub roundtrip over WebSocket within 2s', async ({ expect }) => {
    const client = mqtt.connect(devBroker.wsUrl, {
      connectTimeout: CONNECT_TIMEOUT,
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end(true);
        reject(new Error('Dev broker WS roundtrip timeout - no response within 2s'));
      }, 2000);

      let messageReceived = false;

      client.on('connect', () => {
        client.subscribe('test/ping-ws', (err) => {
          if (err) {
            clearTimeout(timeout);
            client.end(true);
            reject(err);
            return;
          }

          // Publish a test message
          client.publish('test/ping-ws', 'pong-ws', (err) => {
            if (err) {
              clearTimeout(timeout);
              client.end(true);
              reject(err);
            }
          });
        });
      });

      client.on('message', (topic, message) => {
        if (topic === 'test/ping-ws' && message.toString() === 'pong-ws' && !messageReceived) {
          messageReceived = true;
          clearTimeout(timeout);
          client.end(true);
          resolve();
        }
      });

      client.on('error', (error) => {
        clearTimeout(timeout);
        client.end(true);
        reject(error);
      });
    });
  });
});

describe('MQTT Broker - External (Real Mosquitto)', async () => {
  const externalBrokerAvailable = await isBrokerReachable(EXTERNAL_MQTT_URL);
  const skipExternal = !externalBrokerAvailable;

  if (skipExternal) {
    console.warn(
      `External broker unreachable at ${EXTERNAL_MQTT_URL} - skipping external broker test. ` +
        'Set MQTT_URL env var or start Mosquitto to test real broker integration.',
    );
    it.skip('should complete pub/sub roundtrip against external broker within 2s', async () => {
      // Test skipped - external broker not available
    });
  } else {
    it('should complete pub/sub roundtrip against external broker within 2s', async ({ expect }) => {
      expect(externalBrokerAvailable).toBe(true);

      const client = mqtt.connect(EXTERNAL_MQTT_URL, {
        connectTimeout: CONNECT_TIMEOUT,
      });

      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          client.end(true);
          reject(new Error('External broker roundtrip timeout - no response within 2s'));
        }, 2000);

        let messageReceived = false;

        client.on('connect', () => {
          client.subscribe('test/ping', (err) => {
            if (err) {
              clearTimeout(timeout);
              client.end(true);
              reject(err);
              return;
            }

            // Publish a test message
            client.publish('test/ping', 'pong', (err) => {
              if (err) {
                clearTimeout(timeout);
                client.end(true);
                reject(err);
              }
            });
          });
        });

        client.on('message', (topic, message) => {
          if (topic === 'test/ping' && message.toString() === 'pong' && !messageReceived) {
            messageReceived = true;
            clearTimeout(timeout);
            client.end(true);
            resolve();
          }
        });

        client.on('error', (error) => {
          clearTimeout(timeout);
          client.end(true);
          reject(error);
        });
      });
    });
  }
});
