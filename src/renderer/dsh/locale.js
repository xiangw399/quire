/**
 * The shell's locale: the copy service the reader registers its dictionaries
 * into and binds namespace-scoped translate functions from.
 *
 * The reader ships its dictionaries as `{ zh, en }` pairs of plain objects, so
 * the service only has to pick the active language, keep the registered
 * namespaces, and fall back the way the reader expects: a missing key resolves
 * to the key itself rather than throwing, because the reader registers several
 * namespaces and reads them across many components.
 */
export function createLocaleService(initialLanguage = 'zh') {
  /** namespace -> { zh, en } */
  const namespaces = new Map();
  let language = initialLanguage;
  const listeners = new Set();

  function pick(dictionary) {
    return dictionary?.[language] ?? dictionary?.zh ?? dictionary?.en ?? {};
  }

  return {
    get language() {
      return language;
    },
    setLanguage(next) {
      language = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Register one namespace's dictionaries. */
    register(namespace, dictionary) {
      namespaces.set(namespace, dictionary);
    },
    /**
     * Bind one namespace.
     *
     * The reader calls `t("key")` and occasionally `t("key", { name })`; the
     * second argument fills `{name}` placeholders and is ignored otherwise.
     */
    bind(namespace) {
      const service = this;
      const translate = (key, params) => {
        const dictionary = pick(namespaces.get(namespace));
        const fallback = pick(namespaces.get('common'));
        let text = dictionary[key] ?? fallback[key] ?? key;
        if (params !== undefined) {
          text = String(text).replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
        }
        return text;
      };
      // `t.with` returns the same translate; some readers read it for the
      // namespace's own name, which this shell has no use for.
      translate.with = () => translate;
      translate.namespace = namespace;
      void service;
      return translate;
    },
    /** Every registered namespace, for the boot audit. */
    get namespaces() {
      return [...namespaces.keys()];
    },
  };
}
