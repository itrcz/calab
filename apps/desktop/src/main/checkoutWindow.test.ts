import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Electron wiring of the checkout window (ADR-0084) against a fake Electron: the page's
 * hardening, the guards and the title bar. The pure policy is in checkoutPolicy.test.ts.
 */

type Handler = (...args: unknown[]) => unknown;

class FakeContents extends EventEmitter {
  windowOpen: Handler | null = null;
  loaded: string[] = [];
  closed = false;
  constructor(readonly opts: Record<string, unknown>) {
    super();
  }
  setWindowOpenHandler(h: Handler): void {
    this.windowOpen = h;
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    return Promise.resolve();
  }
  isDestroyed(): boolean {
    return this.closed;
  }
  close(): void {
    this.closed = true;
  }
}

class FakeSession extends EventEmitter {
  permissionRequest: Handler | null = null;
  permissionCheck: Handler | null = null;
  devicePermission: Handler | null = null;
  beforeRequest: { filter: unknown; fn: Handler } | null = null;
  webRequest = {
    onBeforeRequest: (filter: unknown, fn: Handler) =>
      (this.beforeRequest = { filter, fn }),
  };
  getUserAgent = (): string =>
    "Mozilla/5.0 Chrome/140.0.0.0 Calab/3.0.5 Electron/39.0.0 Safari/537.36";
  setUserAgent = vi.fn();
  setPermissionRequestHandler(h: Handler): void {
    this.permissionRequest = h;
  }
  setPermissionCheckHandler(h: Handler): void {
    this.permissionCheck = h;
  }
  setDevicePermissionHandler(h: Handler): void {
    this.devicePermission = h;
  }
  setDisplayMediaRequestHandler = vi.fn();
  clearStorageData = vi.fn(() => Promise.resolve());
  clearCache = vi.fn(() => Promise.resolve());
}

const h = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  windows: [] as unknown[],
  views: [] as unknown[],
  packaged: true,
  openExternal: vi.fn(),
}));

vi.mock("electron", () => {
  class BrowserWindow extends EventEmitter {
    webContents: FakeContents;
    contentView = { addChildView: vi.fn() };
    destroyed = false;
    constructor(readonly opts: { webPreferences: Record<string, unknown> }) {
      super();
      this.webContents = new FakeContents(opts.webPreferences);
      h.windows.push(this);
    }
    getContentSize(): number[] {
      return [520, 760];
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    show(): void {}
    close(): void {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  class WebContentsView {
    webContents: FakeContents;
    constructor(opts: { webPreferences: Record<string, unknown> }) {
      this.webContents = new FakeContents(opts.webPreferences);
      h.views.push(this);
    }
    setBackgroundColor(): void {}
    setBounds(): void {}
  }
  return {
    app: {
      get isPackaged() {
        return h.packaged;
      },
    },
    BrowserWindow,
    WebContentsView,
    shell: { openExternal: h.openExternal },
    session: {
      fromPartition: (name: string) => {
        let s = h.sessions.get(name);
        if (!s) h.sessions.set(name, (s = new FakeSession()));
        return s;
      },
    },
  };
});
vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("./auth", () => ({ currentServerUrl: () => "https://app.calab.test" }));

const { openCheckoutWindow } = await import("./checkoutWindow");
const { isCheckoutSession } = await import("./appSessions");

interface Opened {
  win: {
    webContents: FakeContents;
    close(): void;
    opts: { webPreferences: Record<string, unknown> };
  };
  page: FakeContents;
  ses: FakeSession;
  done: Promise<string>;
}

function open(url = "https://checkout.stripe.com/c/pay/cs_test_1"): Opened {
  const parent = {} as never;
  const done = openCheckoutWindow(parent, url);
  const win = h.windows.at(-1) as Opened["win"];
  const page = (h.views.at(-1) as { webContents: FakeContents }).webContents;
  return { win, page, ses: h.sessions.get("checkout") as FakeSession, done };
}

/** Emits a cancellable navigation event; returns whether a listener prevented it. */
function nav(
  wc: FakeContents,
  event: string,
  url: string,
  extra: Record<string, unknown> = {},
): boolean {
  const e = {
    url,
    isMainFrame: true,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  };
  if (event === "will-navigate") wc.emit(event, e, url);
  else wc.emit(event, e);
  return e.prevented;
}

const barHost = (wc: FakeContents): string =>
  decodeURIComponent(wc.loaded.at(-1) ?? "");

beforeEach(() => {
  h.windows.length = 0;
  h.views.length = 0;
  h.openExternal.mockReset();
});

describe("checkout window (ADR-0084)", () => {
  it("hardens the provider page: no preload, sandbox, isolation, no Node, no webview, DevTools off packaged", () => {
    const { page, ses, win } = open();
    expect(page.opts["preload"]).toBeUndefined();
    expect(page.opts).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      devTools: false,
      session: ses,
    });
    expect(isCheckoutSession(ses as never)).toBe(true);
    expect(win.opts.webPreferences).toMatchObject({
      javascript: false,
      sandbox: true,
      devTools: false,
    });
    expect(win.opts.webPreferences["preload"]).toBeUndefined();
    win.close();
  });

  it("refuses permissions, devices, plain http and strips the Electron UA token", () => {
    const { ses, win } = open();
    const cb = vi.fn();
    ses.permissionRequest?.(null, "openExternal", cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(ses.permissionCheck?.()).toBe(false);
    expect(ses.devicePermission?.()).toBe(false);
    const req = vi.fn();
    ses.beforeRequest?.fn({}, req);
    expect(ses.beforeRequest?.filter).toEqual({ urls: ["http://*/*"] });
    expect(req).toHaveBeenCalledWith({ cancel: true });
    expect(ses.setUserAgent).toHaveBeenCalledWith(
      "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
    );
    win.close();
  });

  it("denies new windows from the page and the title bar, nothing reaches the OS", () => {
    const { page, win } = open();
    expect(page.windowOpen?.({ url: "bank100000000111://pay" })).toEqual({
      action: "deny",
    });
    expect(page.windowOpen?.({ url: "https://evil.test/" })).toEqual({
      action: "deny",
    });
    expect(
      win.webContents.windowOpen?.({
        url: "https://calab-checkout.invalid/cancel",
      }),
    ).toEqual({ action: "deny" });
    expect(h.openExternal).not.toHaveBeenCalled();
    win.close();
  });

  it("never offers a client certificate to the page", () => {
    const { page, win } = open();
    const cb = vi.fn();
    const e = { preventDefault: vi.fn() };
    page.emit(
      "select-client-certificate",
      e,
      "https://acs.bank.test",
      [{ subjectName: "me" }],
      cb,
    );
    expect(e.preventDefault).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith();
    win.close();
  });

  it("keeps the page on https, refuses SBP app links and other schemes, frames included", () => {
    const { page, win } = open();
    expect(nav(page, "will-navigate", "https://acs.issuer.test/3ds")).toBe(
      false,
    );
    expect(nav(page, "will-navigate", "bank100000000111://pay?x=1")).toBe(true);
    expect(nav(page, "will-navigate", "https://qr.nspk.ru/AS1000")).toBe(true);
    expect(nav(page, "will-navigate", "file:///etc/passwd")).toBe(true);
    expect(nav(page, "will-redirect", "http://acs.issuer.test/")).toBe(true);
    expect(
      nav(page, "will-frame-navigate", "calab://open", { isMainFrame: false }),
    ).toBe(true);
    expect(
      nav(page, "will-redirect", "javascript:alert(1)", { isMainFrame: false }),
    ).toBe(true);
    expect(h.openExternal).not.toHaveBeenCalled();
    win.close();
  });

  it("a return URL closes the window with an advisory outcome", async () => {
    const { page, done } = open();
    expect(
      nav(
        page,
        "will-navigate",
        "https://app.calab.test/api/billing/return?checkout=1",
      ),
    ).toBe(true);
    await expect(done).resolves.toBe("returned");
  });

  it("the title bar follows committed navigations only (no host of a pending one)", () => {
    const { page, win } = open();
    expect(barHost(win.webContents)).toContain("checkout.stripe.com");
    page.emit("did-start-navigation", {
      url: "https://merch.tochka.com/x",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(barHost(win.webContents)).toContain("checkout.stripe.com");
    page.emit("did-navigate", {}, "https://acs.issuer.test/3ds");
    expect(barHost(win.webContents)).toContain("acs.issuer.test");
    win.close();
  });

  it("«Отмена» in the title bar closes the window, other bar navigations are refused", async () => {
    const { win, done } = open();
    expect(nav(win.webContents, "will-navigate", "https://evil.test/")).toBe(
      true,
    );
    expect(
      nav(
        win.webContents,
        "will-navigate",
        "https://calab-checkout.invalid/cancel",
      ),
    ).toBe(true);
    await expect(done).resolves.toBe("closed");
  });

  it("wipes the page session when the window closes", () => {
    const { ses, win } = open();
    ses.clearStorageData.mockClear();
    win.close();
    expect(ses.clearStorageData).toHaveBeenCalled();
    expect(ses.clearCache).toHaveBeenCalled();
  });
});
