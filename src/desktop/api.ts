/**
 * Minimal typings for the `deno desktop` runtime APIs we use. The real
 * declarations only exist when compiling with `deno desktop`, so plain
 * `deno check` / `deno test` go through these instead.
 */

export type MenuItem =
  | { item: { label: string; id?: string; accelerator?: string; enabled: boolean } }
  | { submenu: { label: string; items: MenuItem[] } }
  | "separator";

export interface BrowserWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  resizable?: boolean;
  alwaysOnTop?: boolean;
}

export interface BrowserWindow extends EventTarget {
  // deno-lint-ignore no-explicit-any
  bind(name: string, fn: (...args: any[]) => unknown): void;
  setTitle(title: string): void;
  setSize(width: number, height: number): void;
  setApplicationMenu(menu: MenuItem[]): void;
  navigate(url: string): void;
  isVisible(): boolean;
  show(): void;
  hide(): void;
  focus(): void;
  reload(): void;
}

export interface Tray extends EventTarget {
  readonly trayId: number;
  setIcon(png: Uint8Array): void;
  setIconDark(png: Uint8Array | null): void;
  setTooltip(text: string | null): void;
  setMenu(menu: MenuItem[] | null): void;
  destroy(): void;
}

export interface Dock extends EventTarget {
  setVisible(visible: boolean): void;
}

export interface DesktopApi {
  BrowserWindow: new (options?: BrowserWindowOptions) => BrowserWindow;
  Tray: new () => Tray;
  dock: Dock;
}

export function desktopApi(): DesktopApi {
  const api = Deno as unknown as Partial<DesktopApi>;
  if (!api.BrowserWindow || !api.Tray) {
    throw new Error("deno desktop APIs not available: run with `deno task dev` or a built app");
  }
  return api as DesktopApi;
}

/** `Notification` exists in the desktop runtime; fall back to the platform notifier. */
export function webNotify(title: string, body: string): boolean {
  const N = (globalThis as { Notification?: new (t: string, o?: { body?: string }) => unknown })
    .Notification;
  if (!N) return false;
  new N(title, { body });
  return true;
}
