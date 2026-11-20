/**
 * The release this server is. The git tag is the repository's one version (scripts/version.sh); the image is built
 * with it as DRAWER_VERSION, and a server run from a checkout reports 0.0.0 unless the variable is set.
 */
const fromEnv = process.env.DRAWER_VERSION?.trim();

export const VERSION: string = fromEnv === undefined || fromEnv === "" ? "0.0.0" : fromEnv;
