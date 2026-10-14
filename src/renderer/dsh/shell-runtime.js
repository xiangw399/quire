/**
 * The shell runtime: wires the slot service, the resource model, the locale, the
 * tab registry, and the reader's own bundles into one context the reader accepts.
 *
 * `createShellRuntime` is the only place that knows both sides: the services the
 * reader asks for and the host functions the shell owns.
 */
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { createSlotService, selectorHookOf, isObservable, bindSlotHook, EMPTY_SOURCE, READER_SEATS } from './slot-service.js';
import { createSettingsHost } from './settings-host.js';
import { LOCAL_SESSION_ID } from './session.js';
import { THEME_SETTINGS_KEY } from './contract.js';

/**
 * Create the reader's client runtime.
 * @param options - the loaded plugin bundles and the host faces they use.
 */
export function createShellRuntime(options) {
  const { plugins, remote, resources, locale, onError } = options;

  const core = new SlotCore();
  const slotService = createSlotService({
    core,
    seats: READER_SEATS,
    composeProps: (entry, ownerProps) => composeProps(entry, ownerProps),
  });

  /** Runtime records per registration, so a stored entry resolves its store. */
  const registrations = [];
  const providedServices = new Map();
  const effects = [];
  /** Named (or every-event) listeners, for the context's event bus. */
  const eventListeners = new Set();
  const rootHooks = new Map();
  const rootKeyedHooks = new Map();
  /** The store instances one registration's handle resolves to. */
  const storeInstances = new Map();
  /**
   * The theme plugin's settings seat.
   *
   * It reads its preference and content font size from here and writes them back
   * when they change, so the shell supplies the same host shape DSH does and keeps
   * the values in local storage.
   *
   * The defaults matter: the plugin adopts the host's values unconditionally at
   * construction, so an empty settings object would leave its preference undefined
   * and its theme registry lookup would fail. These are the same defaults its own
   * schema declares.
   */
  const themeSettingsHost = createSettingsHost({
    namespace: THEME_SETTINGS_KEY,
    values: { preference: 'system', fontSize: 14, ...(options.themeSettings ?? {}) },
    // A throwaway profile (a verification run) must see the configured default rather
    // than whatever a previous run remembered.
    restore: options.restoreSettings !== false,
  });
  /** Tab types the reader declared, for the shell's own chrome. */
  const tabTypes = [];
  /**
   * How the shell turns a nested slot occurrence into an element.
   *
   * React elements are the shell's business, not the runtime's, so the shell
   * installs this before the reader boots.
   */
  let occurrenceRenderer = () => null;
  /**
   * Child-slot declarations, keyed by slot name.
   *
   * A parent entry declares its children (and the hook factories those children
   * receive). The shell needs the same table when it renders a child occurrence,
   * because the declaration is the only place the slot-level hooks live.
   */
  const childSpecs = new Map();
  /**
   * Slot-level hook factories the shell supplies itself, by hook name.
   *
   * The reader declares that its document seats receive `tabInfo`, but the
   * factory for that hook normally comes from the chrome that declares the seat —
   * the right Sidebar, in DSH. A shell that owns its chrome installs its own
   * factory here, and it wins over the declared one.
   */
  const slotHookFactories = new Map();

  /** The store instance one registration's handle resolves to. */
  function instanceFor(record) {
    const handle = record.store;
    if (handle === undefined) return undefined;
    const key = `${record.scopeKey}`;
    let byScope = storeInstances.get(handle);
    if (byScope === undefined) {
      byScope = new Map();
      storeInstances.set(handle, byScope);
    }
    if (!byScope.has(key)) byScope.set(key, handle.create(record.scopeKey));
    return byScope.get(key);
  }

  /** Find the runtime record behind a stored slot entry. */
  function recordOf(entry) {
    return registrations.find((record) => record.component === entry.component && record.key === entry.options.key);
  }

  /**
   * Compose one entry's props: owner share, session standard kit, the entry's own
   * inject face with its hooks bound, the store seat, and the locale seat.
   *
   * @param entry - the stored slot entry.
   * @param ownerProps - the owner's share from the render site.
   * @param render - the render occurrence's slot name, whose child declaration
   *                 supplies the slot-level hook factories, plus the opaque value
   *                 those factories receive.
   */
  function composeProps(entry, ownerProps, render = {}) {
    const record = recordOf(entry);
    const declaration = record?.declaration ?? {};
    const props = { ...ownerProps, sessionId: LOCAL_SESSION_ID };

    const hooks = new Map(rootHooks);
    let injected = {};
    if (typeof declaration.inject === 'function') {
      const instance = record === undefined ? undefined : instanceFor(record);
      injected = declaration.inject(LOCAL_SESSION_ID, instance?.actions) ?? {};
      for (const [name, source] of Object.entries(injected.hooks ?? {})) hooks.set(name, source);
    }

    for (const [name, source] of hooks) props[hookPropName(name)] = bindSlotHook(source, { sessionId: LOCAL_SESSION_ID }, render.hookContext);
    for (const [name, source] of rootKeyedHooks) {
      props[hookPropName(name)] = (key, selector, equal) => selectorHookOf(source(key) ?? EMPTY_SOURCE)(selector, equal);
    }
    for (const [name, value] of Object.entries(injected)) {
      if (name === 'hooks' || name === 'keyedHooks') continue;
      props[name] = value;
    }

    // Slot-level hooks: the declaration of the slot this occurrence renders in
    // names a factory per hook, and the occurrence supplies the value it receives
    // (the parent's own bound hook). This is how a document body gets the same
    // tab reader its parent is using.
    //
    // The reader's *own* tab body has no declaration above it — the shell's seed
    // entry declares the seat — so the shell supplies `tabInfo` for every slot it
    // renders, using the declaration's factory when there is one and its own
    // otherwise.
    const declared = render.slotName === undefined ? {} : (childSpecs.get(render.slotName)?.inject?.hooks ?? {});
    const hookNames = new Set([...Object.keys(declared), ...slotHookFactories.keys()]);
    for (const name of hookNames) {
      const source = slotHookFactories.get(name) ?? declared[name];
      if (source === undefined) continue;
      props[hookPropName(name)] = bindSlotHook(source, { sessionId: LOCAL_SESSION_ID }, render.hookContext);
    }

    if (record?.store !== undefined) {
      const instance = instanceFor(record);
      props.useStore = selectorHookOf(instance);
      props.actions = instance.actions;
    }
    if (declaration.locale !== undefined) props.t = locale.bind(declaration.locale);
    // Every registration that declared children renders them through this seat.
    props.renderSlot = (name, childProps, childOpts) =>
      occurrenceRenderer(name, childProps, { ...childOpts, hookContext: childOpts?.hookContext ?? render.hookContext });

    return props;
  }

  const ctx = {
    effect(run, label) {
      const dispose = run();
      effects.push({ label, dispose });
      return dispose;
    },
    /**
     * The event bus.
     *
     * A plugin may listen for and publish events — the theme plugin publishes
     * `theme/change` whenever its preference or font size changes — so the context
     * carries both halves. Listeners are keyed by name; a listener registered without
     * one hears everything, which is what cordis's bare `on` means.
     */
    on(name, listener) {
      if (typeof name === 'function') {
        const entry = { name: undefined, listener: name };
        eventListeners.add(entry);
        return () => eventListeners.delete(entry);
      }
      const entry = { name, listener };
      eventListeners.add(entry);
      return () => eventListeners.delete(entry);
    },
    emit(name, ...args) {
      for (const entry of [...eventListeners]) {
        if (entry.name !== undefined && entry.name !== name) continue;
        try {
          entry.listener(...(entry.name === undefined ? [name, ...args] : args));
        } catch (error) {
          console.error(`[shell] listener for "${name}" failed:`, error);
        }
      }
      return true;
    },
    inject(names, callback) {
      callback(ctx);
    },
    /**
     * Publish one service for the caller's lifetime.
     *
     * Cordis offers two shapes for the same act — `ctx.reflect.provide(name, value)`
     * and the `ctx.provide(name, value)` alias some plugins use — so both are
     * offered here and both write the same table.
     */
    provide(name, value) {
      providedServices.set(name, value);
      return () => providedServices.delete(name);
    },
    reflect: {
      provide(name, value) {
        providedServices.set(name, value);
        return () => providedServices.delete(name);
      },
      get: (name) => providedServices.get(name),
      set(name, value) {
        providedServices.set(name, value);
        return () => providedServices.delete(name);
      },
    },
    locale: {
      register(namespace, dict) {
        locale.register(namespace, dict);
      },
      bind: (namespace) => locale.bind(namespace),
    },
    get remote() {
      return remote;
    },
    get resources() {
      return resources;
    },
    /**
     * The tab-type registry the reader's tab type declares itself into.
     *
     * The reader only ever calls `register` here; the shell's own tab strip is its
     * own, so the definitions are kept for diagnostics and for the chip title the
     * shell draws.
     */
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition);
        return () => {
          const at = tabTypes.indexOf(definition);
          if (at >= 0) tabTypes.splice(at, 1);
        };
      },
    },
    /**
     * Feature switches and settings hosts.
     *
     * Two different things are read from here, and the shape says which:
     *
     *  - plain switches, such as `developerTools.enabled`, which gates the reader's
     *    script-capable HTML preview (the shell keeps the safe static preview until
     *    it is deliberately turned on);
     *  - settings hosts, such as `ui-theme`, which a plugin reads and writes through
     *    `getSnapshot()`/`set()` because its own shell persists user settings. Those
     *    are reached two ways in the wild: `ctx.configForms.get(name)` and the plain
     *    property of the same name, so both are honoured.
     */
    configForms: {
      developerTools: { enabled: options.interactiveHtmlPreview === true },
      [THEME_SETTINGS_KEY]: themeSettingsHost,
      get(name) {
        return this[name];
      },
    },
    /**
     * The reader's own renderer registry, provided by the reader during boot and
     * read back by its tab body.
     */
    get documentPreviews() {
      return providedServices.get('documentPreviews');
    },
    slots: {
      register(declaration, component) {
        const record = {
          name: declaration.name,
          key: declaration.key,
          store: declaration.store,
          scopeKey: declaration.scopeKey ?? LOCAL_SESSION_ID,
          inject: declaration.inject,
          locale: declaration.locale,
          component,
          declaration,
        };
        registrations.push(record);
        for (const [childName, spec] of Object.entries(declaration.children ?? {})) {
          childSpecs.set(childName, spec);
        }
        // A plugin may ship chrome this shell does not host — the theme contributes
        // a settings row. That registration is tolerated: its seat is declared so the
        // call succeeds, and the entry simply has no outlet.
        return slotService.registerTolerant(declaration, component);
      },
      inject(name, register) {
        void name;
        // A contribution into a seat this shell never declared is chrome it does
        // not host — the theme's settings row, for instance. That registration is
        // tolerated (its seat is declared so the call succeeds) rather than failing
        // the boot; `ctx.slots.register` refuses only undeclared seats, and the
        // tolerant path checks that itself.
        const dispose = register();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      /**
       * Render a nested slot occurrence.
       *
       * The reader's own bodies dispatch their children through this call, naming
       * the key and the occurrence's hook value; the shell resolves the entry and
       * composes its props.
       */
      renderSlot(name, ownerProps, opts) {
        return occurrenceRenderer(name, ownerProps, opts);
      },
      provideRoot(spec) {
        for (const [name, source] of Object.entries(spec.hooks ?? {})) rootHooks.set(name, source);
        for (const [name, source] of Object.entries(spec.keyedHooks ?? {})) rootKeyedHooks.set(name, source);
      },
      get core() {
        return core;
      },
    },
  };

  return {
    ctx,
    core,
    slotService,
    LOCAL_SESSION_ID,
    /** Install the shell's element renderer for nested slot occurrences. */
    installOccurrenceRenderer(renderer) {
      occurrenceRenderer = renderer;
    },
    /** Install the shell's own factory for a slot-level hook the reader declares. */
    installSlotHookFactory(name, factory) {
      slotHookFactories.set(name, factory);
    },
    /** The tab types the reader declared. */
    get tabTypes() {
      return tabTypes;
    },
    /** Apply every loaded reader bundle against this context. */
    boot() {
      for (const plugin of plugins) {
        if (typeof plugin?.apply === 'function') plugin.apply(ctx);
      }
      return this;
    },
    /** What the reader asked for and got, for the boot audit. */
    diagnostics() {
      return {
        platformModules: options.platformModules ?? [],
        registrations: registrations.map((record) => `${record.name}${record.key ? ` [${record.key}]` : ''}`),
        providedServices: [...providedServices.keys()],
        rootHooks: [...rootHooks.keys(), ...rootKeyedHooks.keys()],
        seededSeats: slotService.seededSeats,
        effects: effects.map((effect) => effect.label).filter(Boolean),
        error: onError ?? null,
      };
    },
    dispose() {
      for (const effect of [...effects].reverse()) {
        if (typeof effect.dispose === 'function') effect.dispose();
      }
      effects.length = 0;
      slotService.dispose();
    },
  };
}

/** `deviceId` -> `useDeviceId`. */
function hookPropName(name) {
  return `use${name[0].toUpperCase()}${name.slice(1)}`;
}
