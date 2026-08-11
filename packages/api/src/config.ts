export interface ApiConfig {
  mode: "demo" | "vda";
  port: number;
  tickMs: number;
  mqttUrl?: string;
  devBroker: boolean;
  databaseUrl?: string;
  pgliteDir?: string;
  mapFile?: string;
  robots: number;
}

function intEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const mode = env.DEMO === "1" ? "demo" : "vda";
  const devBroker = env.DEV_BROKER === "1";

  // In vda mode with explicit DEMO=0, MQTT_URL is required unless DEV_BROKER is enabled
  if (mode === "vda" && env.DEMO === "0" && !devBroker && !env.MQTT_URL) {
    throw new Error("MQTT_URL is required in vda mode without DEV_BROKER");
  }

  return {
    mode,
    port: intEnv(env, "PORT", 8080),
    tickMs: intEnv(env, "TICK_MS", 500),
    mqttUrl: env.MQTT_URL,
    devBroker,
    databaseUrl: env.DATABASE_URL,
    pgliteDir: env.PGLITE_DIR,
    mapFile: env.MAP_FILE,
    robots: intEnv(env, "ROBOTS", 3),
  };
}
