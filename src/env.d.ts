/**
 * 离线 Node.js 与内置 node:sqlite 最小类型声明。
 * 用途：在未联网安装 @types/node 的环境下，确保 `npm run typecheck` 可离线严格校验全部服务端与前端源码。
 * 说明：对 node:fs / node:os / node:path 采用 namespace + export = 形式，以同时兼容默认导入值访问
 * 以及 `fs.Stats`、`fs.promises.FileHandle` 等命名空间类型标注。
 */

declare namespace NodeJS {
  interface ErrnoException extends Error {
    errno?: number;
    code?: string;
    path?: string;
    syscall?: string;
  }
}

interface Buffer extends Uint8Array {
  toString(
    encoding?: "utf8" | "utf-8" | "latin1" | "ascii" | "hex" | "base64",
    start?: number,
    end?: number,
  ): string;
}

interface BufferConstructor {
  alloc(size: number, fill?: string | number): Buffer;
  from(
    input: string,
    encoding?: "utf8" | "utf-8" | "latin1" | "ascii" | "hex" | "base64",
  ): Buffer;
  from(input: ArrayLike<number> | ArrayBufferView): Buffer;
  byteLength(
    input: string | Buffer | Uint8Array,
    encoding?: "utf8" | "utf-8" | "latin1",
  ): number;
  isBuffer(obj: unknown): obj is Buffer;
}

declare const Buffer: BufferConstructor;

interface NodeWriteStreamLike {
  write(chunk: string | Uint8Array): boolean;
}

interface Process {
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
  readonly argv: string[];
  cwd(): string;
  exit(code?: number): never;
  kill(pid: number, signal?: string | number): true;
  readonly stderr: NodeWriteStreamLike;
  readonly stdout: NodeWriteStreamLike;
}

declare const process: Process;

declare module "node:fs" {
  namespace fs {
    export interface Stats {
      readonly size: number;
      readonly mtimeMs: number;
      readonly ctimeMs: number;
      readonly birthtimeMs: number;
      isFile(): boolean;
      isDirectory(): boolean;
    }

    export namespace promises {
      export interface FileHandle {
        read(
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ): Promise<{ bytesRead: number; buffer: Buffer }>;
        close(): Promise<void>;
      }

      export function stat(filePath: string): Promise<Stats>;
      export function readdir(dirPath: string): Promise<string[]>;
      export function readFile(filePath: string, encoding: "utf8" | "utf-8"): Promise<string>;
      export function readFile(filePath: string): Promise<Buffer>;
      export function open(filePath: string, flags?: string): Promise<FileHandle>;
      export function mkdir(
        dirPath: string,
        options?: { recursive?: boolean },
      ): Promise<string | undefined>;
      export function copyFile(src: string, dest: string): Promise<void>;
      export function writeFile(
        filePath: string,
        data: string | Uint8Array,
        encoding?: "utf8" | "utf-8",
      ): Promise<void>;
    }

    export function existsSync(filePath: string): boolean;
    export function readFileSync(filePath: string, encoding: "utf8" | "utf-8"): string;
    export function readFileSync(filePath: string): Buffer;
    export function mkdirSync(
      dirPath: string,
      options?: { recursive?: boolean },
    ): string | undefined;
    export function writeFileSync(
      filePath: string,
      data: string | Uint8Array,
      encoding?: "utf8" | "utf-8",
    ): void;
  }

  export = fs;
}

declare module "node:os" {
  namespace os {
    export function homedir(): string;
    export function tmpdir(): string;
  }

  export = os;
}

declare module "node:path" {
  namespace path {
    export interface PlatformPathLike {
      join(...paths: string[]): string;
      resolve(...paths: string[]): string;
      dirname(p: string): string;
      basename(p: string, suffix?: string): string;
      extname(p: string): string;
      normalize(p: string): string;
      relative(from: string, to: string): string;
    }

    export function join(...paths: string[]): string;
    export function resolve(...paths: string[]): string;
    export function dirname(p: string): string;
    export function basename(p: string, suffix?: string): string;
    export function extname(p: string): string;
    export function normalize(p: string): string;
    export function relative(from: string, to: string): string;
    export const posix: PlatformPathLike;
    export const win32: PlatformPathLike;
  }

  export = path;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(filepath: string): URL;
}

declare module "node:sqlite" {
  export interface StatementSync {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
