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
  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = parseInt(value, 10);
  return parsed;
}

/**
 * Same as `intEnv`, but additionally rejects zero/negative values. Used for
 * PORT/TICK_MS/ROBOTS: 0 or negative silently breaks these downstream (e.g.
 * TICK_MS=0 turns the lockstep interval into a ~1000Hz busy loop, ROBOTS=-1
 * spawns an empty fleet, PORT<=0 fails late inside Fastify's listen()) so
 * they're rejected here, at config load, with a message naming the var.
 */
function positiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const parsed = intEnv(env, name, fallback);
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const mode = env.DEMO === "1" ? "demo" : "vda";
  const devBroker = env.DEV_BROKER === "1";

  // In vda mode, MQTT_URL is required unless DEV_BROKER is enabled
  if (mode === "vda" && !devBroker && !env.MQTT_URL) {
    throw new Error("MQTT_URL is required in vda mode without DEV_BROKER");
  }

  return {
    mode,
    port: positiveIntEnv(env, "PORT", 8080),
    tickMs: positiveIntEnv(env, "TICK_MS", 500),
    mqttUrl: env.MQTT_URL,
    devBroker,
    databaseUrl: env.DATABASE_URL,
    pgliteDir: env.PGLITE_DIR,
    mapFile: env.MAP_FILE,
    robots: positiveIntEnv(env, "ROBOTS", 3),
  };
}
