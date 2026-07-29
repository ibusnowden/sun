/**
 * `import prompt from "./x.md" with { type: "text" }` — Bun inlines the file
 * as a string at build time. TypeScript needs to be told the shape.
 */
declare module "*.md" {
  const contents: string;
  export default contents;
}
