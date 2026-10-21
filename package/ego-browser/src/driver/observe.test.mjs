import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  browserCdp,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import {
  captureScreenshot,
  snapshot,
  snapshotText,
} from "../../dist/src/driver/observe.js";
import { setOverrides } from "../../dist/src/state.js";

function withCdpRuntime(fn) {
  const previous = globalThis.ego;
  const sent = [];
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "target-1",
            active: true,
            title: "Example",
            url: "https://example.com/",
          },
        ],
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png").toString("base64") };
      } else if (request.method === "Runtime.evaluate") {
        result = {
          result: {
            value:
              request.params.expression === "window.devicePixelRatio"
                ? 2
                : {
                    w: 800,
                    h: 600,
                    sx: 24,
                    sy: 1200,
                    pw: 1600,
                    ph: 3000,
                  },
          },
        };
      }
      queueMicrotask(() =>
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result })),
      );
    },
    emit(method, params) {
      runtime.onCDPMessage(
        JSON.stringify({ sessionId: "session-1", method, params }),
      );
    },
  };
  globalThis.ego = runtime;
  invalidateSession();
  return Promise.resolve()
    .then(() => fn({ runtime, sent }))
    .finally(() => {
      invalidateSession();
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("snapshot compacts the native result before returning it", async () => {
  const previous = globalThis.ego;
  const calls = [];
  globalThis.ego = {
    async snapshot(options) {
      calls.push(options);
      return {
        content: [
          "root",
          "  container",
          "    button [ref=1, loc=unstable]",
        ].join("\n"),
        refs: [{ refId: 1, backendNodeId: 1, loc: "unstable" }],
      };
    },
  };

  try {
    const result = await snapshot({ scope: "full_page" });
    assert.deepEqual(calls, [{ scope: "full_page" }]);
    assert.equal(result.content, "root\n  button [ref=1]");
    assert.equal(result.refs[0].loc, undefined);
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("snapshotText forwards a subtree root to the native snapshot", async () => {
  const previous = globalThis.ego;
  const calls = [];
  globalThis.ego = {
    async snapshot(options) {
      calls.push(options);
      return { content: "button [ref=21]", refs: [] };
    },
  };

  try {
    assert.equal(
      await snapshotText({ scope: "subtree", root: 21 }),
      "button [ref=21]",
    );
    assert.deepEqual(calls, [
      {
        scope: "subtree",
        root: 21,
        includeActionMarks: true,
        includeStableLocator: true,
      },
    ]);
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("captureScreenshot fails fast while a native dialog is pending", async () => {
  const writes = [];
  const restore = setOverrides({
    async writeFile(path, data) {
      writes.push({ path, data });
    },
  });
  try {
    await withCdpRuntime(async ({ runtime, sent }) => {
      await browserCdp("Runtime.evaluate", { expression: "document.title" });
      runtime.emit("Page.javascriptDialogOpening", {
        type: "alert",
        message: "Blocked",
        url: "https://example.com/",
      });
      sent.length = 0;

      // Chromium does not answer Page.captureScreenshot until the dialog
      // closes, so the capture must not be attempted at all.
      await assert.rejects(
        () => captureScreenshot("/tmp/ego-browser-dialog-shot.png"),
        (error) => {
          assert.equal(error.code, "EGO_PAGE_DIALOG_OPENED");
          assert.match(error.message, /page\.dismissDialog\(\)/);
          return true;
        },
      );
      assert.equal(
        sent.some(
          (request) =>
            request.method === "Runtime.evaluate" ||
            request.method === "Page.captureScreenshot",
        ),
        false,
      );
    });
  } finally {
    restore();
  }

  assert.equal(writes.length, 0);
});

test("captureScreenshot clips the currently visible scrolled viewport", async () => {
  const restore = setOverrides({
    async writeFile() {},
  });
  try {
    await withCdpRuntime(async ({ sent }) => {
      await captureScreenshot("/tmp/ego-browser-scrolled-shot.png");

      const screenshot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.deepEqual(screenshot.params, {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          x: 24,
          y: 1200,
          width: 800,
          height: 600,
          scale: 0.5,
        },
      });
    });
  } finally {
    restore();
  }
});

test("captureScreenshot keeps CSS-pixel sizing when scale is explicit", async () => {
  const restore = setOverrides({
    async writeFile() {},
  });
  try {
    await withCdpRuntime(async ({ sent }) => {
      await captureScreenshot("/tmp/ego-browser-css-shot.png", {
        scale: "css",
      });

      assert.equal(
        sent.some((request) => request.method === "Runtime.evaluate"),
        true,
      );
      const screenshot = sent.find(
        (request) => request.method === "Page.captureScreenshot",
      );
      assert.equal(screenshot.params.clip.scale, 0.5);
    });
  } finally {
    restore();
  }
});

test("captureScreenshot rejects unsupported device scale", async () => {
  await assert.rejects(
    () =>
      captureScreenshot("/tmp/ego-browser-device-shot.png", {
        scale: "device",
      }),
    /captureScreenshot scale must be css/,
  );
});

test("captureScreenshot creates missing parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-browser-screenshot-test-"));
  const outputPath = join(root, "nested", "screenshots", "page.png");
  try {
    await withCdpRuntime(async () => {
      assert.equal(await captureScreenshot(outputPath), outputPath);
    });
    assert.equal(await readFile(outputPath, "utf8"), "png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captureScreenshot without a path writes unique files to EGO_BROWSER_OUTPUT_DIR", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-browser-output-dir-test-"));
  const previous = globalThis.EGO_BROWSER_OUTPUT_DIR;
  globalThis.EGO_BROWSER_OUTPUT_DIR = root;
  try {
    await withCdpRuntime(async () => {
      const first = await captureScreenshot();
      const second = await captureScreenshot();
      assert.equal(dirname(first), root);
      assert.equal(dirname(second), root);
      assert.match(basename(first), /^ego-browser-shot-\d{6}\.png$/);
      assert.notEqual(first, second);
      assert.equal(await readFile(first, "utf8"), "png");
    });
  } finally {
    if (previous === undefined) delete globalThis.EGO_BROWSER_OUTPUT_DIR;
    else globalThis.EGO_BROWSER_OUTPUT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("captureScreenshot without a path falls back to tmpdir", async () => {
  assert.equal(globalThis.EGO_BROWSER_OUTPUT_DIR, undefined);
  const restore = setOverrides({ async writeFile() {} });
  try {
    await withCdpRuntime(async () => {
      assert.equal(dirname(await captureScreenshot()), tmpdir());
    });
  } finally {
    restore();
  }
});

test("captureScreenshot rejects a relative EGO_BROWSER_OUTPUT_DIR", async () => {
  const previous = globalThis.EGO_BROWSER_OUTPUT_DIR;
  globalThis.EGO_BROWSER_OUTPUT_DIR = "shots";
  const restore = setOverrides({ async writeFile() {} });
  try {
    await withCdpRuntime(async () => {
      await assert.rejects(
        captureScreenshot(),
        /EGO_BROWSER_OUTPUT_DIR must be an absolute directory path/,
      );
    });
  } finally {
    restore();
    if (previous === undefined) delete globalThis.EGO_BROWSER_OUTPUT_DIR;
    else globalThis.EGO_BROWSER_OUTPUT_DIR = previous;
  }
});

// --- Minimized-window recovery -------------------------------------------------
// Chromium on Windows refuses Page.captureScreenshot while the native window is
// minimized. The capture path restores the window through the Browser domain and
// retries once, so agents get their screenshot instead of a lost round.

function withMinimizedWindowRuntime(fn) {
  const previous = globalThis.ego;
  const sent = [];
  let restoreCount = 0;
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "target-1",
            active: true,
            title: "Example",
            url: "https://example.com/",
          },
        ],
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      let result = {};
      let error;
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Page.captureScreenshot") {
        // Fail until the window is restored, then succeed — the exact shape of
        // the real Windows behaviour.
        if (restoreCount === 0) {
          error = {
            code: -32000,
            message:
              "Cannot capture a screenshot while the window is minimized.",
          };
        } else {
          result = { data: Buffer.from("png").toString("base64") };
        }
      } else if (request.method === "Browser.getWindowForTarget") {
        result = { windowId: 7, bounds: { windowState: "minimized" } };
      } else if (request.method === "Browser.setWindowBounds") {
        restoreCount += 1;
        result = {};
      } else if (request.method === "Runtime.evaluate") {
        result = {
          result: {
            value:
              request.params.expression === "window.devicePixelRatio"
                ? 1
                : { w: 800, h: 600, sx: 0, sy: 0, pw: 800, ph: 600 },
          },
        };
      }
      queueMicrotask(() =>
        runtime.onCDPMessage(
          JSON.stringify(
            error ? { id: request.id, error } : { id: request.id, result },
          ),
        ),
      );
    },
    emit(method, params) {
      runtime.onCDPMessage(
        JSON.stringify({ sessionId: "session-1", method, params }),
      );
    },
  };
  globalThis.ego = runtime;
  invalidateSession();
  return Promise.resolve()
    .then(() => fn({ runtime, sent, restored: () => restoreCount }))
    .finally(() => {
      invalidateSession();
      if (previous === undefined) delete globalThis.ego;
      else globalThis.ego = previous;
    });
}

test("captureScreenshot restores a minimized window and retries once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-browser-minimized-test-"));
  const outputPath = join(root, "page.png");
  try {
    await withMinimizedWindowRuntime(async ({ sent, restored }) => {
      assert.equal(
        await captureScreenshot(outputPath, {}, undefined, "target-1"),
        outputPath,
      );
      assert.equal(restored(), 1, "window restored exactly once");
      const methods = sent.map((r) => r.method);
      assert.deepEqual(
        methods.filter((m) => m === "Page.captureScreenshot").length,
        2,
        "captured twice: failed attempt plus retry",
      );
      assert.ok(
        methods.includes("Browser.getWindowForTarget"),
        "looked up the window",
      );
      assert.ok(
        methods.includes("Browser.setWindowBounds"),
        "restored the window",
      );
      // The retry must carry the original clip/format options unchanged.
      const shots = sent.filter((r) => r.method === "Page.captureScreenshot");
      assert.deepEqual(shots[1].params, shots[0].params);
    });
    assert.equal(await readFile(outputPath, "utf8"), "png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captureScreenshot without a path falls back to tmpdir", async () => {
  assert.equal(globalThis.EGO_BROWSER_OUTPUT_DIR, undefined);
  const restore = setOverrides({ async writeFile() {} });
  try {
    await withCdpRuntime(async () => {
      assert.equal(dirname(await captureScreenshot()), tmpdir());
    });
  } finally {
    restore();
  }
});

test("captureScreenshot rejects a relative EGO_BROWSER_OUTPUT_DIR", async () => {
  const previous = globalThis.EGO_BROWSER_OUTPUT_DIR;
  globalThis.EGO_BROWSER_OUTPUT_DIR = "shots";
  const restore = setOverrides({ async writeFile() {} });
  try {
    await withCdpRuntime(async () => {
      await assert.rejects(
        captureScreenshot(),
        /EGO_BROWSER_OUTPUT_DIR must be an absolute directory path/,
      );
    });
  } finally {
    restore();
    if (previous === undefined) delete globalThis.EGO_BROWSER_OUTPUT_DIR;
    else globalThis.EGO_BROWSER_OUTPUT_DIR = previous;
  }
});

test("captureScreenshot surfaces unrelated screenshot errors unchanged", async () => {
  const previous = globalThis.ego;
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "target-1",
            active: true,
            title: "T",
            url: "https://e.com/",
          },
        ],
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      let result = {};
      let error;
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Page.captureScreenshot") {
        error = { code: -32000, message: "Something else went wrong" };
      } else if (request.method === "Runtime.evaluate") {
        result = {
          result: {
            value:
              request.params.expression === "window.devicePixelRatio"
                ? 1
                : { w: 800, h: 600, sx: 0, sy: 0, pw: 800, ph: 600 },
          },
        };
      }
      queueMicrotask(() =>
        runtime.onCDPMessage(
          JSON.stringify(
            error ? { id: request.id, error } : { id: request.id, result },
          ),
        ),
      );
    },
    emit() {},
  };
  globalThis.ego = runtime;
  invalidateSession();
  try {
    await assert.rejects(
      () => captureScreenshot("/tmp/ego-browser-other-error.png"),
      /Something else went wrong/,
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});
