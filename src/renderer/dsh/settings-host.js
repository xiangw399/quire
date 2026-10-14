/**
 * A settings host for plugins that expect the shell to persist user settings.
 *
 * DSH's settings surface hands a plugin an entry host with `getSnapshot()`,
 * `set(field, value)`, and `subscribe()`. The theme plugin reads its preference
 * and content font size through exactly that seat, and writes them back when the
 * user changes them.
 *
 * The shell keeps the values in memory and, when a storage key is supplied,
 * mirrors them into `localStorage` so a choice survives a restart. Nothing else
 * about DSH's settings service is reproduced: there is no transport, no schema
 * validation beyond the defaults, and no settings UI — a plugin that ships a
 * settings row simply has no outlet for it here.
 */

/**
 * Create one settings host.
 * @param options - the namespace, the defaults, an optional storage key, and whether
 *                  persisted values may override the defaults.
 */
export function createSettingsHost({ namespace, values, storageKey, restore = true } = {}) {
  const defaults = { ...(values ?? {}) };
  let current = { ...defaults };
  const listeners = new Set();

  const key = storageKey ?? (namespace === undefined ? undefined : `quire:settings:${namespace}`);

  /**
   * Restore what a previous run saved.
   *
   * A caller running with a throwaway profile turns this off: a remembered choice
   * from an earlier session would otherwise decide the state under test, which is
   * how a "default" ends up looking broken.
   */
  if (key !== undefined && restore) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      if (raw !== null && raw !== undefined) current = { ...defaults, ...JSON.parse(raw) };
    } catch {
      // Unreadable or unparsable storage keeps the defaults.
    }
  }

  /** Persist the current values, best effort. */
  function persist() {
    if (key === undefined) return;
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(current));
    } catch {
      // A full or unavailable store must not break a settings change.
    }
  }

  return {
    /** The namespace this host was created for. */
    namespace,
    /** The current settings as the entry expects to read them. */
    getSnapshot: () => ({ value: { ...current } }),
    /**
     * Update one field.
     * @param field - the field name.
     * @param value - its new value.
     */
    set(field, value) {
      if (current[field] === value) return;
      current = { ...current, [field]: value };
      persist();
      for (const listener of [...listeners]) listener({ value: { ...current } });
    },
    /** Observe later changes. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The current values, for diagnostics. */
    get values() {
      return { ...current };
    },
  };
}
