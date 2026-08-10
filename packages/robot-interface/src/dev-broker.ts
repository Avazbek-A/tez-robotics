import http from 'http';
import net from 'net';
import aedes from 'aedes';
import wsStream from 'websocket-stream';

export interface DevBrokerResult {
  port: number;
  wsPort: number;
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

export interface DevBrokerOptions {
  port?: number;
  wsPort?: number;
}

/**
 * Listen on a port with automatic fallback to ephemeral (0) if busy.
 * Resolves when server is listening.
 */
async function listenWithFallback(server: net.Server | http.Server, targetPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.listen(port, 'localhost', () => {
        const actualPort = (server.address() as net.AddressInfo).port;
        resolve(actualPort);
      });

      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) {
          // Port busy, retry with ephemeral port
          server.removeListener('error', onError);
          tryListen(0);
        } else {
          reject(err);
        }
      };

      server.once('error', onError);
    };

    tryListen(targetPort);
  });
}

/**
 * Start a development MQTT broker using aedes for local testing.
 * Supports both MQTT (TCP) and WebSocket protocols.
 *
 * @param opts Configuration options
 * @param opts.port MQTT TCP port (default 1883, uses ephemeral 0 if busy)
 * @param opts.wsPort WebSocket port (default 9001, uses ephemeral 0 if busy)
 * @returns Promise resolving to broker info with close() method
 */
export async function startDevBroker(opts?: DevBrokerOptions): Promise<DevBrokerResult> {
  const targetPort = opts?.port ?? 1883;
  const targetWsPort = opts?.wsPort ?? 9001;

  const broker = aedes();
  const mqttServer = net.createServer(broker.handle);
  const wsHttpServer = http.createServer();

  // Use websocket-stream to properly bridge WebSocket to MQTT protocol
  wsStream.createServer({ server: wsHttpServer }, (stream) => {
    broker.handle(stream);
  });

  try {
    // Start MQTT TCP server
    const actualPort = await listenWithFallback(mqttServer, targetPort);

    // Start WebSocket server
    const actualWsPort = await listenWithFallback(wsHttpServer, targetWsPort);

    const result: DevBrokerResult = {
      port: actualPort,
      wsPort: actualWsPort,
      url: `mqtt://localhost:${actualPort}`,
      wsUrl: `ws://localhost:${actualWsPort}`,
      close: async () => {
        return new Promise<void>((resolve, reject) => {
          mqttServer.close((err1) => {
            if (err1) {
              reject(err1);
              return;
            }
            wsHttpServer.close((err2) => {
              if (err2) {
                reject(err2);
                return;
              }
              broker.close((err3) => {
                if (err3) reject(err3);
                else resolve();
              });
            });
          });
        });
      },
    };

    return result;
  } catch (err) {
    mqttServer.close();
    wsHttpServer.close();
    broker.close();
    throw err;
  }
}
