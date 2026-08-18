/**
 * @dsh-external/dsh-deepseek-quota — browser half type declarations.
 *
 * The client bundle (`lib/client.js`) is served raw by the client-modules
 * system and registers itself through the browser module loader; this file
 * only models that registration contract for editors.
 */

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(entry: {
        id: string;
        factory: (require: (id: string) => unknown) => unknown;
      }): void;
    };
  }
}

export {};
