/**
 * The shell's React context: the values every piece of chrome and every reader
 * body reads.
 *
 * The reader's own components receive their inputs as slot props (composed by
 * the slot service), so this context carries only what the shell's chrome needs:
 * the slot service itself, the resource hook, the translate function, and the
 * live tab record.
 */
import { createContext, useContext } from 'react';

/** The shell's live context value. */
export const ShellContext = createContext(undefined);

/** Read the shell context; throws when a component renders outside the shell. */
export function useShell() {
  const value = useContext(ShellContext);
  if (value === undefined) throw new Error('shell components must render inside <ShellProvider>');
  return value;
}

/**
 * The tab-information hook the reader's bodies and titles call.
 *
 * Its shape is the reader's contract (`SidebarRightTabInfo`), which stays
 * deliberately narrow: the shell exposes the record, the navigation state, the
 * abort signal, and the tab's own actions, and nothing about panes or docking.
 */
export function useTabInfo() {
  return useShell().tabInfo;
}

/**
 * The slot-level tab reader the reader's document seats declare.
 *
 * The reader's own chrome supplies this by forwarding the hook its pane already
 * has; a shell that owns its chrome supplies the same thing directly. The shape
 * is a `SlotHookFactory`: it receives the standard share and the occurrence's
 * context and returns the hook a document body calls.
 *
 * @param _standard - the standard props share (unused: the tab record comes from
 *                    the shell's context, not from the occurrence).
 * @param hookContext - the parent occurrence's own tab reader, forwarded as-is.
 * @returns the tab reader the body should call.
 */
export function tabInfoHookFactory(_standard, hookContext) {
  return typeof hookContext === 'function' ? hookContext : useShellTabInfo;
}

/** Fallback reader for an occurrence that supplied no context. */
function useShellTabInfo() {
  return useTabInfo();
}

/** The resource hook: live metadata for one `dsh-resource://` address. */
export function useResource(address) {
  return useShell().useResource(address);
}
