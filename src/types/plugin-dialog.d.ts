// Minimal ambient declaration so tsc passes before `pnpm install` materializes
// the real types from `@tauri-apps/plugin-dialog`. After install this file is
// shadowed by the package's own declarations — keeping it around is harmless
// (TS picks the more-specific module declaration from node_modules).
declare module "@tauri-apps/plugin-dialog" {
  export type OpenDialogOptions = {
    title?: string;
    directory?: boolean;
    multiple?: boolean;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  };
  export function open(
    options: OpenDialogOptions & { directory: true; multiple?: false },
  ): Promise<string | null>;
  export function open(
    options: OpenDialogOptions & { directory: true; multiple: true },
  ): Promise<string[] | null>;
  export function open(
    options?: OpenDialogOptions,
  ): Promise<string | string[] | null>;
}
