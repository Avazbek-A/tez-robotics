import net from 'net';
import { WebSocketServer } from 'ws';
import aedes from 'aedes';

export interface DevBrokerResult {
  port: number;
  wsPort: number;
  url: string;
  close(): Promise<void>;
}

export interface DevBrokerOptions {
  port?: number;
  wsPort?: number;
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
  const wsServer = new WebSocketServer({ noServer: true });

  // Setup WebSocket upgrade handler
  mqttServer.on('upgrade', (req, socket, head) => {
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      broker.handle(ws);
    });
  });

  return new Promise((resolve, reject) => {
    // Try to bind to target port, fall back to ephemeral (0) if busy
    mqttServer.listen(targetPort, 'localhost', () => {
      const actualPort = (mqttServer.address() as net.AddressInfo).port;

      // Handle WebSocket on separate listener
      const httpServer = net.createServer();
      httpServer.on('upgrade', (req, socket, head) => {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          broker.handle(ws);
        });
      });

      httpServer.listen(targetWsPort, 'localhost', () => {
        const actualWsPort = (httpServer.address() as net.AddressInfo).port;

        const result: DevBrokerResult = {
          port: actualPort,
          wsPort: actualWsPort,
          url: `mqtt://localhost:${actualPort}`,
          close: async () => {
            return new Promise<void>((resolveClose, rejectClose) => {
              mqttServer.close(() => {
                httpServer.close(() => {
                  broker.close((err) => {
                    if (err) rejectClose(err);
                    else resolveClose();
                  });
                });
              });
            });
          },
        };

        resolve(result);
      });

      httpServer.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          // Port busy, retry with ephemeral port
          httpServer.listen(0, 'localhost', () => {
            const actualWsPort = (httpServer.address() as net.AddressInfo).port;
            const result: DevBrokerResult = {
              port: actualPort,
              wsPort: actualWsPort,
              url: `mqtt://localhost:${actualPort}`,
              close: async () => {
                return new Promise<void>((resolveClose, rejectClose) => {
                  mqttServer.close(() => {
                    httpServer.close(() => {
                      broker.close((err) => {
                        if (err) rejectClose(err);
                        else resolveClose();
                      });
                    });
                  });
                });
              },
            };
            resolve(result);
          });
        } else {
          reject(err);
        }
      });
    });

    mqttServer.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // Port busy, retry with ephemeral port
        mqttServer.listen(0, 'localhost', () => {
          const actualPort = (mqttServer.address() as net.AddressInfo).port;

          const httpServer = net.createServer();
          httpServer.on('upgrade', (req, socket, head) => {
            wsServer.handleUpgrade(req, socket, head, (ws) => {
              broker.handle(ws);
            });
          });

          httpServer.listen(targetWsPort, 'localhost', () => {
            const actualWsPort = (httpServer.address() as net.AddressInfo).port;

            const result: DevBrokerResult = {
              port: actualPort,
              wsPort: actualWsPort,
              url: `mqtt://localhost:${actualPort}`,
              close: async () => {
                return new Promise<void>((resolveClose, rejectClose) => {
                  mqttServer.close(() => {
                    httpServer.close(() => {
                      broker.close((err) => {
                        if (err) rejectClose(err);
                        else resolveClose();
                      });
                    });
                  });
                });
              },
            };

            resolve(result);
          });

          httpServer.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
              httpServer.listen(0, 'localhost', () => {
                const actualWsPort = (httpServer.address() as net.AddressInfo).port;
                const result: DevBrokerResult = {
                  port: actualPort,
                  wsPort: actualWsPort,
                  url: `mqtt://localhost:${actualPort}`,
                  close: async () => {
                    return new Promise<void>((resolveClose, rejectClose) => {
                      mqttServer.close(() => {
                        httpServer.close(() => {
                          broker.close((err) => {
                            if (err) rejectClose(err);
                            else resolveClose();
                          });
                        });
                      });
                    });
                  },
                };
                resolve(result);
              });
            } else {
              reject(err);
            }
          });
        });
      } else {
        reject(err);
      }
    });
  });
}
