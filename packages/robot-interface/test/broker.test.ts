import { describe, it, beforeAll } from 'vitest';
import * as mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const CONNECT_TIMEOUT = 500;

async function isBrokerUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const client = mqtt.connect(MQTT_URL, {
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

describe('MQTT Broker', () => {
  let brokerUp = false;
  let skipBroker = false;

  beforeAll(async () => {
    brokerUp = await isBrokerUp();
    skipBroker = !process.env.CI && !brokerUp;
  });

  it.skipIf(skipBroker)(
    'should complete pub/sub roundtrip on test/ping topic within 2s',
    async ({ expect }) => {
      expect(brokerUp).toBe(true);

      const client = mqtt.connect(MQTT_URL, {
        connectTimeout: CONNECT_TIMEOUT,
      });

      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          client.end();
          reject(new Error('Broker roundtrip timeout - no response within 2s'));
        }, 2000);

        let messageReceived = false;

        client.on('connect', () => {
          client.subscribe('test/ping', (err) => {
            if (err) {
              clearTimeout(timeout);
              client.end();
              reject(err);
              return;
            }

            // Publish a test message
            client.publish('test/ping', 'pong', (err) => {
              if (err) {
                clearTimeout(timeout);
                client.end();
                reject(err);
              }
            });
          });
        });

        client.on('message', (topic, message) => {
          if (topic === 'test/ping' && message.toString() === 'pong' && !messageReceived) {
            messageReceived = true;
            clearTimeout(timeout);
            client.end();
            resolve();
          }
        });

        client.on('error', (error) => {
          clearTimeout(timeout);
          client.end();
          reject(error);
        });
      });
    },
  );
});
