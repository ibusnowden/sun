import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathGuard {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  static async create(root: string): Promise<PathGuard> {
    return new PathGuard(await realpath(root));
  }

  async resolve(path: string, options: { allowMissing?: boolean } = {}): Promise<string> {
    if (path.includes("\0")) throw new Error("Path contains a null byte");
    const candidate = resolve(this.#root, path);
    this.#assertInside(candidate);

    try {
      const canonical = await realpath(candidate);
      this.#assertInside(canonical);
      return canonical;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        !options.allowMissing
      ) {
        throw error;
      }
      await this.#validateExistingComponents(candidate);
      return candidate;
    }
  }

  #assertInside(path: string): void {
    const result = relative(this.#root, path);
    if (result === "" || (!result.startsWith("..") && !isAbsolute(result))) return;
    throw new Error(`Path escapes repository root: ${path}`);
  }

  async #validateExistingComponents(candidate: string): Promise<void> {
    const relativePath = relative(this.#root, candidate);
    const parts = relativePath.split(sep).filter(Boolean);
    let current = this.#root;
    for (const part of parts) {
      current = resolve(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          let canonical: string;
          try {
            canonical = await realpath(current);
          } catch {
            throw new Error(`Refusing to follow dangling symlink: ${current}`);
          }
          this.#assertInside(canonical);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
}
