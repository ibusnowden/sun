import manifest from "../package.json" with { type: "json" };

/**
 * The single source of the version and package name.
 *
 * These used to be a `const VERSION = "0.1.0"` in cli.ts sitting next to an
 * independent number in package.json. Two numbers that must agree but are
 * edited separately disagree on the first release, and an update check that
 * compares a stale constant against the registry is worse than no check at
 * all: it tells the user they are current when they are not.
 *
 * Bun inlines the import at build time, so the compiled binary carries the
 * version it was built from rather than hunting for a package.json that is
 * not shipped beside it.
 */
export const VERSION: string = manifest.version;
export const PACKAGE_NAME: string = manifest.name;
