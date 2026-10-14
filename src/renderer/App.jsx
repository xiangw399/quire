/**
 * The shell: a tab strip and the reader's body.
 *
 * The window belongs to the document. There is no file browser: a document arrives
 * from the file picker, from a drop, or from an operating-system "open with", and
 * the reader occupies everything below the tab strip — the shape DSH's own sidebar
 * takes. The host keeps a *root* only to resolve paths a document refers to
 * (relative images in Markdown, relative scripts and stylesheets in HTML).
 *
 * No reader component is imported here: a body is resolved from the reader's own
 * registration in `sidebar.right.pane.tab`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShellContext } from './dsh/runtime-context.js';
import { fileAddressOf } from './dsh/resources.js';
import { renderSlotOccurrence } from './dsh/slot-service.js';
import { READER_TAB_ID, SLOTS } from './dsh/contract.js';
import { EmptyState } from './EmptyState.jsx';
import { ReaderBody } from './ReaderBody.jsx';

/**
 * How many times the shell advances a tab's navigation revision while looking for a
 * line reference. The reader marks the target line only once it has paged that far,
 * so the search is a bounded sequence of nudges — and one that never finds the line
 * has to end as a message rather than as a loop nobody can see.
 */
const MAX_LINE_ATTEMPTS = 40;

/** The basename of a path, for a tab title. */
function basename(target) {
  const parts = String(target).split(/[\\/]/);
  return parts[parts.length - 1] || String(target);
}

/**
 * The shell application.
 * @param props - the booted runtime, the host face the chrome reads through, and
 *                the navigation parameters an opening reference supplied.
 */
export function App({ runtime, host, openWith }) {
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(undefined);
  /** The line a jump gave up on, so the failure is visible instead of silent. */
  const [jumpFailure, setJumpFailure] = useState(undefined);
  /** One tab lifetime per mounted reader body; aborted when the tab closes. */
  const lifetime = useMemo(() => new AbortController().signal, []);
  const tabSeq = useRef(0);

  const shellHost = host ?? globalThis.__DSH_VIEWER_HOST__ ?? runtime.host;

  /**
   * Open (or reveal) one file as a tab.
   * @param target - absolute path, or a key for a file the page itself holds.
   * @param params - navigation parameters for the new tab (`{ line }` for a file
   *                 reference, absent for a plain open).
   */
  const openPath = useCallback((target, params) => {
    if (target === undefined || target === null || target === '') return;
    const address = fileAddressOf(target);
    const id = `tab-${(tabSeq.current += 1)}`;
    const tab = {
      id,
      address,
      path: target,
      title: basename(target),
      controller: new AbortController(),
      navigation: { address, params, revision: 0 },
    };
    setTabs((current) => {
      const existing = current.find((candidate) => candidate.address === address);
      if (existing !== undefined) {
        // Revealing an open tab still delivers the new target, so a second
        // reference to the same file jumps again rather than doing nothing.
        existing.navigation = { address, params, revision: existing.navigation.revision + 1 };
        setActiveId(existing.id);
        return [...current];
      }
      setActiveId(id);
      return [...current, tab];
    });
  }, []);

  /** Close one tab and abort its reads. */
  const closeTab = useCallback((id) => {
    setTabs((current) => {
      const closing = current.find((tab) => tab.id === id);
      closing?.controller.abort();
      const next = current.filter((tab) => tab.id !== id);
      setActiveId((active) => (active === id ? next[next.length - 1]?.id : active));
      return next;
    });
  }, []);

  /**
   * Ask for documents and open them.
   *
   * The desktop shell answers with absolute paths. A page has no such dialog, so
   * there a hidden file input stands in: its `File` objects are readable by the
   * page even though their paths are not.
   */
  const pickFiles = useCallback(async () => {
    const bridge = globalThis.docviewer;
    if (bridge !== undefined) {
      for (const target of await bridge.workspace.chooseFiles()) openPath(target);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      for (const file of input.files ?? []) {
        if (shellHost.adopt !== undefined) openPath(shellHost.adopt(file));
      }
    });
    input.click();
  }, [openPath, shellHost]);

  // Desktop affordances: files dropped on the window open as tabs, an operating
  // system "open with" arrives over the bridge, and the main process reaches the
  // shell's own open path through the global it publishes here.
  //
  // The bridge is told the page is listening only once these listeners exist, so a
  // document a launch named is never handed over before there is anywhere to put it.
  useEffect(() => {
    globalThis.__DSH_VIEWER_PICK__ = () => void pickFiles();
    globalThis.__DSH_VIEWER_OPEN_PATH__ = (target) => openPath(target);
    const bridge = globalThis.docviewer;
    const off = bridge?.workspace.onShellOpen((target) => openPath(target));
    bridge?.ready?.();
    return () => {
      delete globalThis.__DSH_VIEWER_PICK__;
      delete globalThis.__DSH_VIEWER_OPEN_PATH__;
      if (typeof off === 'function') off();
    };
  }, [openPath, pickFiles]);

  useEffect(() => {
    const onDrop = (event) => {
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      const bridge = globalThis.docviewer;
      for (const file of files) {
        const absolute = bridge?.workspace.pathForFile(file);
        if (absolute !== undefined && absolute !== '') openPath(absolute);
        else if (shellHost.adopt !== undefined) openPath(shellHost.adopt(file));
      }
    };
    const onDragOver = (event) => event.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
    };
  }, [openPath, shellHost]);

  // The picker's keyboard shortcut, matching the chip the empty state shows.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void pickFiles();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickFiles]);

  // An opening reference — a command-line path, a harness hand-off — opens through
  // the same path a click uses, with the line it carried.
  const openedWith = useRef(undefined);
  useEffect(() => {
    const target = globalThis.__DSH_VIEWER_OPEN__;
    if (target === undefined) return;
    if (openedWith.current === target) return;
    openedWith.current = target;
    openPath(target, openWith);
  }, [openWith, openPath]);

  const active = tabs.find((tab) => tab.id === activeId);
  const activeSignal = active?.controller.signal ?? lifetime;
  const targetLine = openWith?.line;

  // What the shell's navigation knows, for harnesses and diagnostics.
  useEffect(() => {
    globalThis.__DSH_VIEWER_NAV__ = {
      targetLine,
      revision: active?.navigation.revision ?? 0,
      opened: tabs.length,
      activeId,
    };
  });

  /**
   * Pilot a jump to a line.
   *
   * The reader pages toward a line only when the navigation revision changes, and
   * it marks the line once it has loaded that far. So the shell advances the active
   * tab's revision — one step per attempt, bounded — until the marker appears.
   */
  useEffect(() => {
    if (targetLine === undefined || active === undefined) {
      setJumpFailure(undefined);
      return undefined;
    }
    if (document.querySelector(`[data-textpreview-target="${targetLine}"]`) !== null) {
      setJumpFailure(undefined);
      return undefined;
    }
    // The budget is finite because every step re-renders the reader: once it is spent
    // the line is not going to appear, and saying so is the only useful outcome left.
    if ((active.navigation.revision ?? 0) >= MAX_LINE_ATTEMPTS) {
      setJumpFailure(targetLine);
      return undefined;
    }
    setTabs((current) => {
      const at = current.findIndex((tab) => tab.id === active.id);
      if (at < 0) return current;
      const next = [...current];
      next[at] = { ...current[at], navigation: { ...current[at].navigation, revision: current[at].navigation.revision + 1 } };
      return next;
    });
    return undefined;
  }, [targetLine, active?.id, active?.navigation.revision]);

  const tabInfo = useMemo(() => {
    if (active === undefined) return undefined;
    return {
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: active.id,
        kind: 'text',
        contentId: active.address,
        title: active.title,
        visible: true,
        navigation: active.navigation,
        signal: activeSignal,
        actions: {
          bindCommands: () => () => {},
          openResource: () => {},
          openTab: () => {},
          close: () => closeTab(active.id),
        },
      },
    };
  }, [active, activeSignal, closeTab]);

  /** The resource snapshot the shell's own chrome reads. */
  const useResource = useCallback((address) => runtime.resources.source(address).getSnapshot(), [runtime]);

  /**
   * The renderer for nested slot occurrences: the reader's tab body dispatches its
   * document body, its toolbar actions, and its title through the same slots it
   * declared, and each occurrence receives the tab reader as its hook context —
   * exactly how the reader's own host passes it.
   */
  useEffect(() => {
    runtime.installOccurrenceRenderer((name, ownerProps = {}, opts = {}) => {
      const occurrence = renderSlotOccurrence(runtime.slotService, name, ownerProps, {
        entryKey: opts.entryKey,
        only: opts.only,
        hookContext: opts.hookContext ?? tabInfo,
      });
      if (occurrence === undefined) return opts.fallback ?? null;
      const { Component, props } = occurrence;
      return <Component key={`${name}:${opts.entryKey ?? opts.only ?? 'default'}`} {...props} />;
    });
  }, [runtime, tabInfo]);

  const shellValue = useMemo(
    () => ({ runtime, host: shellHost, openPath, pickFiles, tabs, active, closeTab, tabInfo, useResource }),
    [runtime, shellHost, openPath, pickFiles, tabs, active, closeTab, tabInfo, useResource],
  );

  return (
    <ShellContext.Provider value={shellValue}>
      <div className="shell">
        {jumpFailure !== undefined && (
          <div className="jump-failure" role="status">
            未找到第 {jumpFailure} 行
          </div>
        )}
        <div className="tabs" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab${tab.id === activeId ? ' tab--active' : ''}`}
              onClick={() => setActiveId(tab.id)}
              role="tab"
              aria-selected={tab.id === activeId}
              tabIndex={0}
              title={tab.path}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setActiveId(tab.id);
              }}
            >
              <span className="tab__title">{tab.title}</span>
              <button
                type="button"
                className="tab__close"
                aria-label={`关闭 ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="body">
          {tabInfo === undefined ? <EmptyState onPick={pickFiles} /> : <ReaderBody runtime={runtime} key={active.id} />}
        </div>
      </div>
    </ShellContext.Provider>
  );
}

