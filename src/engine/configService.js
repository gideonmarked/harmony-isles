// @ts-check

/**
 * Eagerly import every JSON file in /src/configs/ at module load.
 * Vite's import.meta.glob handles this at build time so callers can
 * read configs synchronously without awaiting a fetch.
 */
const configModules = /** @type {Record<string, Record<string, any>>} */ (
  import.meta.glob('../configs/*.json', { eager: true, import: 'default' })
);

/** @type {Record<string, Record<string, any>>} */
const configs = {};

for (const [path, mod] of Object.entries(configModules)) {
  const name = path.replace(/.*\//, '').replace(/\.json$/, '');
  configs[name] = mod;
}

/**
 * Read a named config (e.g. `'main'`, `'characters'`).
 *
 * @param {string} name
 * @returns {Record<string, any>}
 */
export function getConfig(name) {
  const cfg = configs[name];
  if (!cfg) {
    throw new Error(`Config "${name}" not found in src/configs/`);
  }
  return cfg;
}

/** List all loaded config names. */
export function listConfigs() {
  return Object.keys(configs);
}
